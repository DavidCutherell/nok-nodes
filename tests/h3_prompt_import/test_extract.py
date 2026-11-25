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


# Fake ComfyUI's node registry: a few node types in both declaration styles.
def _old_style(inputs, outputs):
    return type("N", (), {"INPUT_TYPES": classmethod(lambda cls: inputs), "RETURN_TYPES": outputs})

fake_nodes = types.ModuleType("nodes")
fake_nodes.NODE_CLASS_MAPPINGS = {
    "CLIPTextEncode": _old_style({"required": {"text": ("STRING", {"multiline": True}), "clip": ("CLIP",)}}, ("CONDITIONING",)),
    "SizedTextEncode": _old_style({"required": {"text": ("STRING", {"multiline": True}), "width": ("INT", {}), "clip": ("CLIP",)}}, ("CONDITIONING",)),
    "KSampler": _old_style({"required": {"positive": ("CONDITIONING",), "negative": ("CONDITIONING",), "seed": ("INT", {}),
                                         "sampler_name": (["euler", "lcm"],)}}, ("LATENT",)),
    "TextBox": _old_style({"required": {"value": ("STRING", {"multiline": True})}}, ("STRING",)),
    "Joiner": _old_style({"required": {"a": ("STRING", {}), "b": ("STRING", {}), "delimiter": ("STRING", {})}}, ("STRING",)),
    "AnySwitch": _old_style({"optional": {"any_01": ("*",), "any_02": ("*",)}}, ("*",)),
    "StylePrompt": _old_style({"required": {"text": ("STRING", {"multiline": True}), "preset": (["film", "anime"],),
                                            "strength": ("FLOAT", {}), "data": ("STRING", {})}}, ("STRING",)),
    "LoraLoader": _old_style({"required": {"lora_name": (["a.safetensors"],), "model": ("MODEL",), "clip": ("CLIP",)}}, ("MODEL", "CLIP")),
    # Declared the newer way: one call returns the whole description.
    "RefTextEncode": type("V3", (), {"GET_NODE_INFO_V1": classmethod(lambda cls: {
        "input": {"required": {"prompt": ["STRING", {"multiline": True}], "clip": ["CLIP"], "length": ["INT", {}]}},
        "output": ["CONDITIONING", "STRING", "LATENT"]})}),
    "Broken": type("B", (), {"INPUT_TYPES": classmethod(lambda cls: 1 / 0), "RETURN_TYPES": ()}),
}
sys.modules["nodes"] = fake_nodes

# Load the pack the way ComfyUI does: by path, under an arbitrary module name.
spec = importlib.util.spec_from_file_location("nok_nodes", os.path.join(REPO, "__init__.py"),
                                              submodule_search_locations=[REPO])
pack = importlib.util.module_from_spec(spec)
sys.modules["nok_nodes"] = pack
spec.loader.exec_module(pack)
from nok_nodes.h3_prompt_import import describe_node
from nok_nodes.h3_prompt_import.extract import extract, prompt_nodes, builders_from_workflow, _filled, BUILDER

import av
from PIL import Image
from PIL.PngImagePlugin import PngInfo

fails = 0
def check(label, cond, info=""):
    global fails
    fails += 0 if cond else 1
    print(("PASS " if cond else "FAIL ") + label, info)

def shape(nodes):
    """Ids, types, roles, field names and lengths. Never the text itself."""
    return [(n["id"], n["type"], n["role"], n["text_field"], {k: (len(v) if isinstance(v, str) else v) for k, v in n["values"].items()}) for n in nodes]


check("pack loads the tool", "H3PromptImport" in pack.NODE_CLASS_MAPPINGS and pack.WEB_DIRECTORY == "./web",
      f"nodes {sorted(pack.NODE_CLASS_MAPPINGS)}")
check("browser file is where WEB_DIRECTORY points", os.path.isfile(os.path.join(REPO, "web", "h3_prompt_import.js")))

d = describe_node("CLIPTextEncode")
check("describe: classic node", d == {"inputs": {"text": "STRING", "clip": "CLIP"}, "multiline": ["text"], "outputs": ["CONDITIONING"]}, str(d))
d = describe_node("RefTextEncode")
check("describe: newer-style node", d and d["inputs"]["prompt"] == "STRING" and d["multiline"] == ["prompt"] and "CONDITIONING" in d["outputs"])
check("describe: combo input", describe_node("KSampler")["inputs"]["sampler_name"] == "COMBO")
check("describe: unknown and broken types give None", describe_node("NotInstalled") is None and describe_node("Broken") is None)

# ---- Fantastic builder: a two-pass style graph with one filled builder and one empty media bundler
STATE = json.dumps({"version": 3, "mode": "REF", "duration": 8,
                    "ref": {"subjectDefs": [{"text": "a test subject", "name": "Subject 1", "role": "main"},
                                            {"text": "a second test subject", "name": "Subject 2", "role": "other"}],
                            "summaryText": "test summary", "retention": [{"label": "face", "context": "", "marker": "keep", "note": ""}],
                            "styleLine": "test style", "detail": "test detail", "soundscape": "test sound", "music": ""}})
TEXT = "Synthetic prompt text for the test. " * 20
PROMPT = {
    "220": {"class_type": BUILDER, "_meta": {"title": "Prompt Builder"},
            "inputs": {"prompt_text": TEXT, "builder_state": STATE, "Edit prompt": None, "mods": ["9", 0]}},
    "151:210": {"class_type": BUILDER, "_meta": {"title": "Media bundler"}, "inputs": {"prompt_text": "", "builder_state": "{}"}},
    "151:211": {"class_type": "RefTextEncode", "inputs": {"prompt": ["220", 0], "clip": ["4", 0], "length": 97}},
    "4": {"class_type": "CLIPLoader", "inputs": {}},
    "9": {"class_type": "RefMods", "inputs": {}},
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


def is_builder_copy(r):
    n = (r.get("nodes") or [None])[0]
    return bool(r.get("ok") and n and n["type"] == BUILDER and n["values"] == {"prompt_text": TEXT, "builder_state": STATE})


mp4 = make_mp4({"prompt": P, "workflow": W})
for label, describe in (("with node definitions", describe_node), ("without node definitions", None)):
    r0 = extract(mp4, "synthetic.mp4", describe)
    check(f"builder mp4, {label}", r0.get("ok") is True and r0.get("origin") == "prompt", str(shape(r0.get("nodes", []))))
    check("  only the filled builder, both fields identical", len(r0["nodes"]) == 1 and r0["nodes"][0]["id"] == "220" and is_builder_copy(r0))
    check("  text field and summary", r0["nodes"][0]["text_field"] == "prompt_text" and
          r0["nodes"][0]["summary"] == {"mode": "REF", "subjects": 2, "retention": 1, "chars": len(TEXT)})

check("mp4 named .png still read", is_builder_copy(extract(mp4, "x.png")))

r = extract(make_mp4({"workflow": W}), "workflow_only.mp4")
check("workflow-only file falls back to the canvas", is_builder_copy(r) and r["origin"] == "workflow" and r["nodes"][0]["id"] == "220")
c = [x for x in builders_from_workflow(WORKFLOW) if _filled(x)]
check("workflow walk skips the empty subgraph builder", len(c) == 1 and c[0]["id"] == "220")

check("png text chunks", is_builder_copy(extract(png({"prompt": P, "workflow": W}), "frame.png")))
img = Image.new("RGB", (8, 8)); ex = img.getexif()
ex[0x0110] = "prompt:" + P; ex[0x010f] = "workflow:" + W
buf = io.BytesIO(); img.save(buf, "WEBP", exif=ex)
check("webp exif", is_builder_copy(extract(buf.getvalue(), "frame.webp")))
check("nested comment json", is_builder_copy(extract(png({"comment": json.dumps({"prompt": P, "workflow": W})}), "vhs.png")))

# ---- any prompt tool
POS, NEG = "a long positive prompt " * 5, "bad things"
CLASSIC = {
    "6": {"class_type": "CLIPTextEncode", "_meta": {"title": "Positive"}, "inputs": {"text": POS, "clip": ["10", 1]}},
    "7": {"class_type": "CLIPTextEncode", "_meta": {"title": "Negative"}, "inputs": {"text": NEG * 40, "clip": ["10", 1]}},
    "3": {"class_type": "KSampler", "inputs": {"positive": ["6", 0], "negative": ["7", 0], "seed": 5, "sampler_name": "euler"}},
    "10": {"class_type": "LoraLoader", "inputs": {"lora_name": "a.safetensors", "model": ["1", 0], "clip": ["1", 1]}},
}
for label, describe in (("with node definitions", describe_node), ("without node definitions", None)):
    n = prompt_nodes(CLASSIC, describe)
    check(f"classic encoders, {label}: positive first, negative second, nothing else",
          [(x["id"], x["role"], x["text_field"]) for x in n] == [("6", "positive", "text"), ("7", "negative", "text")], str(shape(n)))
    check("  encoder gives up only its text", n[0]["values"] == {"text": POS} and n[0]["title"] == "Positive")

CHAIN = {
    "1": {"class_type": "TextBox", "inputs": {"value": POS}},
    "2": {"class_type": "TextBox", "inputs": {"value": "style words"}},
    "3": {"class_type": "Joiner", "inputs": {"a": ["1", 0], "b": ["5", 0], "delimiter": ", "}},
    "5": {"class_type": "AnySwitch", "inputs": {"any_01": ["2", 0]}},
    "8": {"class_type": "RefTextEncode", "inputs": {"prompt": ["3", 0], "clip": ["4", 0], "length": 97}},
    "9": {"class_type": "TextBox", "inputs": {"value": "a text box that feeds nothing"}},
}
n = prompt_nodes(CHAIN, describe_node)
check("text typed upstream is found through a joiner and a switch", [x["id"] for x in n] == ["1", "2", "3"] and n[0]["text_field"] == "value", str(shape(n)))
check("  an unconnected text box is left out", "9" not in [x["id"] for x in n])

TOOL = {
    "1": {"class_type": "StylePrompt", "inputs": {"text": POS, "preset": "film", "strength": 0.8, "data": json.dumps({"k": "v" * 400})}},
    "2": {"class_type": "SizedTextEncode", "inputs": {"text": ["1", 0], "width": 1024, "clip": ["4", 0]}},
    "3": {"class_type": "SizedTextEncode", "inputs": {"text": "inline", "width": 512, "clip": ["4", 0]}},
}
n = {x["id"]: x for x in prompt_nodes(TOOL, describe_node)}
check("a prompt tool gives up all its settings", set(n["1"]["values"]) == {"text", "preset", "strength", "data"}, str(shape(n.values())))
check("  its main text is the prose, not the longer JSON field", n["1"]["text_field"] == "text")
check("  an encoder with inline text keeps its other settings out", n["3"]["values"] == {"text": "inline"})

# ---- files with nothing to copy
r = extract(png({}), "plain.png")
check("plain png refused", r.get("ok") is False, r.get("error", "")[:60])
r = extract(png({"prompt": json.dumps({"1": {"class_type": "KSampler", "inputs": {"seed": 1}}})}), "other.png", describe_node)
check("graph without prompt text refused", r.get("ok") is False, r.get("error", "")[:60])
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
    check("route: builder mp4", st == 200 and j == extract(mp4, "synthetic.mp4", describe_node) and cache == "no-store", f"status {st}")
    st, j, _ = await asyncio.to_thread(post, png({"prompt": json.dumps(CLASSIC)}), "classic.png")
    check("route: classic png uses the node definitions", st == 200 and [x["role"] for x in j["nodes"]] == ["positive", "negative"])
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
    n = (r.get("nodes") or [{}])[0]
    check(f"real file {i}", r.get("ok") is True and n.get("id") == nid and n["values"].get("prompt_text") == text and n["values"].get("builder_state") == state,
          f"{len(r.get('nodes', []))} prompt node(s), first {n.get('id')} origin {r.get('origin')} summary {n.get('summary')}")

print("FAILS", fails)
sys.exit(1 if fails else 0)
