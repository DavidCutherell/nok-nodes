"""Pull the prompt out of a ComfyUI-generated file.

ComfyUI writes the executed graph ("prompt") and the saved canvas
("workflow") into every video and image it saves. This module finds the nodes
in that graph that hold the prompt, whatever tool they belong to:

* It starts at every text encoder (a node that returns CONDITIONING) and walks
  back along its text inputs to the nodes where the text was typed. That can be
  the encoder itself, a prompt builder, a string node, or a chain of them.
* A Fantastic Prompt Builder is always included. It keeps everything it knows
  in two widgets, `prompt_text` and `builder_state`, so reading those two
  values back is an exact copy of every field in its editor.

Nothing here touches disk: the file arrives as bytes and is parsed in memory.
"""

import io
import json
import os
import re

BUILDER = "MiniMaxH3PromptBuilder"
IMAGE_EXT = {".png", ".webp", ".jpg", ".jpeg", ".gif", ".bmp", ".tif", ".tiff"}
# Input names that usually hold prompt text, most likely first.
TEXT_NAMES = ("prompt_text", "prompt", "text", "positive", "string", "value",
              "text_g", "text_l", "t5xxl", "clip_l", "caption", "description")
ENCODER_HINT = re.compile(r"text.?encode|prompt.?encode", re.I)
MAX_DEPTH = 8


def _as_dict(value):
    """A JSON object from a dict, a JSON string, or a doubly encoded string."""
    for _ in range(3):
        if isinstance(value, (bytes, bytearray)):
            value = bytes(value).decode("utf-8", "replace")
        if isinstance(value, dict):
            return value
        if not isinstance(value, str):
            return None
        try:
            value = json.loads(value)
        except Exception:
            return None
    return value if isinstance(value, dict) else None


def _take(found, key, value):
    """Record a `prompt` / `workflow` tag, wherever the saver put it."""
    key = str(key or "").strip().lower()
    if key in ("prompt", "workflow"):
        obj = _as_dict(value)
        if obj is not None:
            found.setdefault(key, obj)
    elif key in ("comment", "description", "usercomment"):
        # Video Helper Suite packs both into one JSON comment.
        obj = _as_dict(value)
        if obj:
            for inner in ("prompt", "workflow"):
                if inner in obj:
                    _take(found, inner, obj[inner])


def _from_image(data):
    from PIL import Image

    found = {}
    with Image.open(io.BytesIO(data)) as img:
        for k, v in (img.info or {}).items():
            _take(found, k, v)
        try:
            exif = img.getexif()
        except Exception:
            exif = None
        # WebP and JPEG savers store "prompt:{...}" strings in EXIF fields.
        for v in (exif.values() if exif else []):
            if isinstance(v, (bytes, bytearray)):
                v = bytes(v).decode("utf-8", "replace")
            if isinstance(v, str) and ":" in v:
                k, _, rest = v.partition(":")
                if k.strip().lower() in ("prompt", "workflow"):
                    _take(found, k, rest)
    return found


def _from_video(data):
    import av

    found = {}
    container = av.open(io.BytesIO(data))
    try:
        for k, v in (container.metadata or {}).items():
            _take(found, k, v)
        for stream in container.streams:
            for k, v in (stream.metadata or {}).items():
                _take(found, k, v)
    finally:
        container.close()
    return found


def read_metadata(data, name):
    """({'prompt': ..., 'workflow': ...}, [reader errors])."""
    ext = os.path.splitext(name or "")[1].lower()
    readers = [_from_image, _from_video] if ext in IMAGE_EXT else [_from_video, _from_image]
    errors = []
    for reader in readers:
        try:
            found = reader(data)
        except Exception as exc:
            errors.append(f"{reader.__name__[6:]}: {exc}")
            continue
        if found:
            return found, errors
    return {}, errors


def _is_link(value):
    return (isinstance(value, list) and len(value) == 2 and isinstance(value[0], (str, int))
            and isinstance(value[1], int) and not isinstance(value[1], bool))


def _links(value):
    """Every [node_id, slot] link inside an input value, nested ones included."""
    if isinstance(value, list):
        if _is_link(value):
            yield value
        else:
            for item in value:
                yield from _links(item)
    elif isinstance(value, dict):
        for item in value.values():
            yield from _links(item)


def _scalar(value):
    return isinstance(value, (str, int, float, bool))


def _looks_like_json(text):
    text = text.strip()
    return text[:1] in ("{", "[") and text[-1:] in ("}", "]")


# ---------------------------------------------------------------- Fantastic builder

def _candidate(node_id, title, prompt_text, builder_state, origin, active):
    state = _as_dict(builder_state) if isinstance(builder_state, str) else None
    return {
        "id": str(node_id),
        "title": title if isinstance(title, str) else "",
        "prompt_text": prompt_text if isinstance(prompt_text, str) else "",
        "builder_state": builder_state if isinstance(builder_state, str) else "",
        "state": state,
        "origin": origin,
        "active": bool(active),
    }


def builders_from_prompt(prompt):
    """Prompt Builder nodes in the executed graph (API format)."""
    read_by_others = set()
    for node in prompt.values():
        if isinstance(node, dict):
            for value in (node.get("inputs") or {}).values():
                for link in _links(value):
                    read_by_others.add(str(link[0]))
    out = []
    for node_id, node in prompt.items():
        if not isinstance(node, dict) or node.get("class_type") != BUILDER:
            continue
        inputs = node.get("inputs") or {}
        out.append(_candidate(
            node_id, (node.get("_meta") or {}).get("title"),
            inputs.get("prompt_text"), inputs.get("builder_state"),
            "prompt", str(node_id) in read_by_others))
    return out


def builders_from_workflow(workflow):
    """Prompt Builder nodes on the saved canvas, subgraphs included."""
    out = []

    def walk(nodes):
        for node in nodes if isinstance(nodes, list) else []:
            if not isinstance(node, dict) or node.get("type") != BUILDER:
                continue
            values = node.get("widgets_values")
            if isinstance(values, dict):
                text, state = values.get("prompt_text"), values.get("builder_state")
            elif isinstance(values, list) and len(values) >= 2:
                text, state = values[0], values[1]
            else:
                continue
            out.append(_candidate(node.get("id"), node.get("title"), text, state,
                                  "workflow", node.get("mode", 0) == 0))

    walk(workflow.get("nodes"))
    for sub in ((workflow.get("definitions") or {}).get("subgraphs") or []):
        if isinstance(sub, dict):
            walk(sub.get("nodes"))
    return out


def _filled(candidate):
    """A builder that holds a prompt. One used only to bundle media has `{}`."""
    state = candidate["state"]
    return bool(state and state.get("version"))


def _summary(state, prompt_text):
    ref = state.get("ref") if isinstance(state.get("ref"), dict) else {}
    full_ref = state.get("mode") == "REF"
    return {
        "mode": state.get("mode"),
        "subjects": len(ref.get("subjectDefs") or []) if full_ref else 0,
        "retention": len(ref.get("retention") or []) if full_ref else 0,
        "chars": len(prompt_text or ""),
    }


# ---------------------------------------------------------------- any prompt tool

def _roles(prompt):
    """A function: node id -> 'positive' / 'negative' / None, by where its output ends up."""
    consumers = {}
    for cid, node in prompt.items():
        if isinstance(node, dict):
            for name, value in (node.get("inputs") or {}).items():
                for link in _links(value):
                    consumers.setdefault(str(link[0]), []).append((str(cid), str(name).lower()))

    def role(node_id):
        seen, frontier, hits = {str(node_id)}, [str(node_id)], set()
        for _ in range(MAX_DEPTH):
            following = []
            for source in frontier:
                for cid, name in consumers.get(source, []):
                    if "negative" in name or name in ("neg", "uncond"):
                        hits.add("negative")
                    elif "positive" in name or name in ("pos", "cond"):
                        hits.add("positive")
                    elif cid not in seen:
                        seen.add(cid)
                        following.append(cid)
            if hits or not following:
                break
            frontier = following
        return "positive" if "positive" in hits else ("negative" if hits else None)

    return role


def prompt_nodes(prompt, describe=None):
    """The nodes of an executed graph that hold prompt text, most important first.

    `describe(class_type)` may return {"inputs": {name: type}, "multiline":
    [names], "outputs": [types]} for node types installed here, or None. With
    it the search is exact; without it, node and input names are used.

    Each entry: id, type, title, role, text_field (the input holding the main
    text) and values (what to copy into a node of the same type).
    """
    known = {}

    def info(class_type):
        if class_type not in known:
            try:
                known[class_type] = describe(class_type) if describe else None
            except Exception:
                known[class_type] = None
        return known[class_type]

    def is_encoder(node):
        spec = info(node.get("class_type"))
        if spec:
            return "CONDITIONING" in (spec.get("outputs") or [])
        return bool(ENCODER_HINT.search(str(node.get("class_type") or "")))

    def text_inputs(node, at_encoder):
        """(literal text fields, links to follow) of one node."""
        spec = info(node.get("class_type"))
        fields, links = [], []
        for name, value in (node.get("inputs") or {}).items():
            if spec:
                kind = (spec.get("inputs") or {}).get(name)
                wanted = kind == "STRING" or (kind == "*" and not at_encoder)
            elif at_encoder:
                wanted = str(name).lower() in TEXT_NAMES
            else:
                wanted = isinstance(value, str) or str(name).lower() in TEXT_NAMES
            if not wanted:
                continue
            if _is_link(value):
                links.append(value)
            elif isinstance(value, str) and value.strip():
                fields.append(name)
        return fields, links

    role_of = _roles(prompt)
    found = {}   # node id -> {"fields": [...], "role": ..., "encoder": bool}

    def visit(node_id, role, depth, seen):
        node_id = str(node_id)
        node = prompt.get(node_id)
        if node_id in seen or not isinstance(node, dict):
            return
        seen.add(node_id)
        fields, links = text_inputs(node, depth == 0)
        if fields:
            entry = found.setdefault(node_id, {"fields": fields, "role": role, "encoder": depth == 0})
            if role == "positive" or entry["role"] is None:
                entry["role"] = role or entry["role"]
        if depth < MAX_DEPTH:
            for link in links:
                visit(link[0], role, depth + 1, seen)

    for node_id, node in prompt.items():
        if isinstance(node, dict) and is_encoder(node):
            visit(node_id, role_of(node_id), 0, set())

    # A filled Fantastic builder always counts, even if no encoder was traced to it.
    for candidate in builders_from_prompt(prompt):
        if _filled(candidate) and candidate["id"] not in found:
            found[candidate["id"]] = {"fields": ["prompt_text"], "role": None, "encoder": False}

    out = []
    for node_id, hit in found.items():
        node = prompt[node_id]
        inputs = node.get("inputs") or {}
        class_type = str(node.get("class_type") or "")
        entry = {"id": node_id, "type": class_type, "role": hit["role"],
                 "title": (node.get("_meta") or {}).get("title") or ""}
        if class_type == BUILDER:
            state = _as_dict(inputs.get("builder_state")) if isinstance(inputs.get("builder_state"), str) else None
            if not (state and state.get("version")):
                continue        # a builder used only to bundle media holds no prompt
            entry["text_field"] = "prompt_text"
            entry["summary"] = _summary(state, inputs.get("prompt_text"))
        else:
            multiline = set((info(class_type) or {}).get("multiline") or [])
            plain = [f for f in hit["fields"] if not _looks_like_json(inputs[f])] or hit["fields"]
            entry["text_field"] = min(plain, key=lambda f: (
                f not in multiline,
                TEXT_NAMES.index(f.lower()) if f.lower() in TEXT_NAMES else len(TEXT_NAMES),
                -len(inputs[f])))
        # An encoder gives up only its text. A prompt tool gives up all its settings.
        if class_type == BUILDER:
            names = ["prompt_text", "builder_state"]
        elif hit["encoder"]:
            names = hit["fields"]
        else:
            names = [k for k, v in inputs.items() if _scalar(v)]
        entry["values"] = {k: inputs[k] for k in names}
        if not isinstance(entry["values"].get(entry["text_field"]), str):
            continue
        out.append(entry)

    # Negative prompts last; a Fantastic builder first; then what is known to be
    # the positive prompt; then the longest text.
    out.sort(key=lambda e: (e["role"] == "negative", e["type"] != BUILDER,
                            e["role"] != "positive", -len(e["values"][e["text_field"]])))
    return out


def _nodes_from_workflow(workflow):
    """Canvas-only files: widget values there have no names, so only the
    Fantastic builder, whose layout is known, can be read."""
    hits = [c for c in builders_from_workflow(workflow) if _filled(c)]
    hits.sort(key=lambda c: (not c["active"], -len(c["prompt_text"])))
    return [{"id": c["id"], "type": BUILDER, "role": None, "title": c["title"],
             "text_field": "prompt_text", "summary": _summary(c["state"], c["prompt_text"]),
             "values": {"prompt_text": c["prompt_text"], "builder_state": c["builder_state"]}}
            for c in hits]


def analyse(found, errors, name, describe=None):
    """Turn a file's metadata into the list of prompt nodes, or say why not."""
    if not found:
        detail = f" ({'; '.join(errors)})" if errors else ""
        return {"ok": False, "error":
                "This file has no ComfyUI workflow data in it. It may have been "
                "re-encoded, edited or saved by another program." + detail}
    nodes, origin = [], "prompt"
    if isinstance(found.get("prompt"), dict):
        nodes = prompt_nodes(found["prompt"], describe)
    if not nodes and isinstance(found.get("workflow"), dict):
        nodes, origin = _nodes_from_workflow(found["workflow"]), "workflow"
    if not nodes:
        return {"ok": False, "error":
                "This file holds a ComfyUI graph, but no prompt text was found in it."}
    return {"ok": True, "file": os.path.basename(name or ""), "origin": origin, "nodes": nodes}


def extract(data, name, describe=None):
    """The prompt nodes held in a generated file, or why there are none."""
    found, errors = read_metadata(data, name)
    return analyse(found, errors, name, describe)
