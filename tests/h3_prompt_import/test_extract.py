"""Tests for the H3 Prompt Import tool (server side).

Run with a Python that has av, Pillow and aiohttp, for example ComfyUI's own:

    <ComfyUI>/.venv/Scripts/python.exe tests/h3_prompt_import/test_extract.py

By default every sample is synthetic and built in memory. Pass paths of real
ComfyUI-generated files as arguments to also check them against an
independent read of their metadata. Output is lengths and ids only, never
prompt text.
"""
import asyncio, io, json, os, sys, types, importlib.util, urllib.request

REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

# Fake the ComfyUI server module so the pack (route included) imports here.
from aiohttp import web
routes = web.RouteTableDef()
fake = types.ModuleType("server")
fake.PromptServer = types.SimpleNamespace(instance=types.SimpleNamespace(routes=routes))
sys.modules["server"] = fake

# Load the pack the way ComfyUI does: by path, under an arbitrary module name.
spec = importlib.util.spec_from_file_location("nok_nodes", os.path.join(REPO, "__init__.py"),
                                              submodule_search_locations=[REPO])
pack = importlib.util.module_from_spec(spec)
sys.modules["nok_nodes"] = pack
spec.loader.exec_module(pack)
from nok_nodes.h3_prompt_import.extract import extract, builders_from_workflow, _filled, BUILDER

import av
from PIL import Image
from PIL.PngImagePlugin import PngInfo

fails = 0
def check(label, cond, info=""):
    global fails
    fails += 0 if cond else 1
    print(("PASS " if cond else "FAIL ") + label, info)


check("pack loads the tool", "H3PromptImport" in pack.NODE_CLASS_MAPPINGS and pack.WEB_DIRECTORY == "./web",
      f"nodes {sorted(pack.NODE_CLASS_MAPPINGS)}")
check("browser file is where WEB_DIRECTORY points", os.path.isfile(os.path.join(REPO, "web", "h3_prompt_import.js")))

# ---- synthetic sample: a two-pass style graph with one filled builder and one empty media bundler
STATE = json.dumps({"version": 3, "mode": "REF", "duration": 8,
                    "ref": {"subjectDefs": [{"text": "a test subject", "name": "Subject 1", "role": "main"},
                                            {"text": "a second test subject", "name": "Subject 2", "role": "other"}],
                            "summaryText": "test summary", "retention": [{"label": "face", "context": "", "marker": "keep", "note": ""}],
                            "styleLine": "test style", "detail": "test detail", "soundscape": "test sound", "music": ""}})
TEXT = "Synthetic prompt text for the test. " * 20
PROMPT = {
    "220": {"class_type": BUILDER, "_meta": {"title": "Prompt Builder"}, "inputs": {"prompt_text": TEXT, "builder_state": STATE}},
    "151:210": {"class_type": BUILDER, "_meta": {"title": "Media bundler"}, "inputs": {"prompt_text": "", "builder_state": "{}"}},
    "7": {"class_type": "CLIPTextEncode", "inputs": {"text": ["220", 0], "clip": ["4", 0]}},
    "4": {"class_type": "CLIPLoader", "inputs": {}},
}
WORKFLOW = {
    "nodes": [{"id": 220, "type": BUILDER, "mode": 0, "widgets_values": [TEXT, STATE]},
              {"id": 7, "type": "CLIPTextEncode", "mode": 0, "widgets_values": [""]}],
    "definitions": {"subgraphs": [{"id": "sub", "nodes": [{"id": 210, "type": BUILDER, "mode": 0, "widgets_values": ["", "{}"]}]}]},
}
P, W = json.dumps(PROMPT), json.dumps(WORKFLOW)


def make_mp4(metadata):
    """A tiny MP4 tagged the way ComfyUI's SaveVideo tags its files."""
    buf = io.BytesIO()
    c = av.open(buf, mode="w", format="mp4", options={"movflags": "use_metadata_tags"})
    for k, v in metadata.items():
        c.metadata[k] = v
    s = c.add_stream("libx264", rate=8)
    s.width, s.height, s.pix_fmt = 64, 64, "yuv420p"
    for _ in range(4):
        for packet in s.encode(av.VideoFrame.from_image(Image.new("RGB", (64, 64), (40, 60, 80)))):
            c.mux(packet)
    for packet in s.encode():
        c.mux(packet)
    c.close()
    return buf.getvalue()


def png(chunks):
    info = PngInfo()
    for k, v in chunks.items():
        info.add_text(k, v)
    buf = io.BytesIO()
    Image.new("RGB", (8, 8)).save(buf, "PNG", pnginfo=info)
    return buf.getvalue()


mp4 = make_mp4({"prompt": P, "workflow": W})
r0 = extract(mp4, "synthetic.mp4")
check("mp4 container tags", r0.get("ok") is True, f"node {r0.get('node_id')} origin {r0.get('origin')} others {r0.get('others')} summary {r0.get('summary')}")
check("  the filled builder wins over the empty one", r0.get("node_id") == "220" and r0.get("others") == 0)
check("  prompt_text identical", r0.get("prompt_text") == TEXT, f"{len(TEXT)} chars")
check("  builder_state identical", r0.get("builder_state") == STATE, f"{len(STATE)} chars")
check("  summary counts", r0.get("summary") == {"mode": "REF", "subjects": 2, "retention": 1, "chars": len(TEXT)})

check("mp4 named .png still read", extract(mp4, "x.png").get("ok") is True)

r = extract(make_mp4({"workflow": W}), "workflow_only.mp4")
check("workflow-only file falls back to the canvas", r.get("ok") and r["origin"] == "workflow" and r["builder_state"] == STATE and r["node_id"] == "220")
c = [x for x in builders_from_workflow(WORKFLOW) if _filled(x)]
check("workflow walk skips the empty subgraph builder", len(c) == 1 and c[0]["id"] == "220")

r = extract(png({"prompt": P, "workflow": W}), "frame.png")
check("png text chunks", r.get("ok") and r["builder_state"] == STATE)

img = Image.new("RGB", (8, 8)); ex = img.getexif()
ex[0x0110] = "prompt:" + P; ex[0x010f] = "workflow:" + W
buf = io.BytesIO(); img.save(buf, "WEBP", exif=ex)
r = extract(buf.getvalue(), "frame.webp")
check("webp exif", r.get("ok") and r["builder_state"] == STATE)

r = extract(png({"comment": json.dumps({"prompt": P, "workflow": W})}), "vhs.png")
check("nested comment json", r.get("ok") and r["builder_state"] == STATE)

# ---- files with nothing to copy
r = extract(png({}), "plain.png")
check("plain png refused", r.get("ok") is False, r.get("error", "")[:60])
r = extract(png({"prompt": json.dumps({"1": {"class_type": "KSampler", "inputs": {}}})}), "other.png")
check("non-builder workflow refused", r.get("ok") is False, r.get("error", "")[:60])
r = extract(png({"prompt": json.dumps({"1": PROMPT["151:210"]})}), "empty_builder.png")
check("empty builder refused", r.get("ok") is False, r.get("error", "")[:60])
r = extract(b"not a media file at all", "junk.mp4")
check("junk refused", r.get("ok") is False, r.get("error", "")[:60])


# ---- the HTTP route, served the way ComfyUI serves it (100 MB body limit)
async def serve():
    app = web.Application(client_max_size=100 * 1024 * 1024)
    app.add_routes(routes)
    runner = web.AppRunner(app); await runner.setup()
    site = web.TCPSite(runner, "127.0.0.1", 0); await site.start()
    port = site._server.sockets[0].getsockname()[1]

    def post(body, name):
        req = urllib.request.Request(f"http://127.0.0.1:{port}/h3_prompt_import/extract?name={name}",
                                     data=body, method="POST", headers={"Content-Type": "application/octet-stream"})
        with urllib.request.urlopen(req, timeout=60) as resp:
            return resp.status, json.loads(resp.read()), resp.headers.get("Cache-Control")

    st, j, cache = await asyncio.to_thread(post, mp4, "synthetic.mp4")
    check("route: mp4", st == 200 and j == r0 and cache == "no-store", f"status {st}")
    st, j, _ = await asyncio.to_thread(post, b"junk", "junk.mp4")
    check("route: junk", st == 200 and j.get("ok") is False)
    await runner.cleanup()
asyncio.run(serve())


# ---- optional: real generated files given on the command line
def truth(path):
    """The builder values read straight from the container, independently."""
    c = av.open(path); md = dict(c.metadata); c.close()
    best = None
    for nid, n in json.loads(md["prompt"]).items():
        if n.get("class_type") == BUILDER and json.loads(n["inputs"]["builder_state"]).get("version"):
            assert best is None, "more than one filled builder"
            best = (nid, n["inputs"]["prompt_text"], n["inputs"]["builder_state"])
    return best

for i, path in enumerate(sys.argv[1:], 1):
    nid, text, state = truth(path)
    r = extract(open(path, "rb").read(), os.path.basename(path))
    check(f"real file {i}", r.get("ok") is True and r.get("node_id") == nid and r.get("prompt_text") == text and r.get("builder_state") == state,
          f"node {r.get('node_id')} origin {r.get('origin')} summary {r.get('summary')}")

print("FAILS", fails)
sys.exit(1 if fails else 0)
