"""Pull the Fantastic Prompt Builder's fields out of a ComfyUI-generated file.

ComfyUI writes the executed graph ("prompt") and the saved canvas
("workflow") into every video and image it saves. The Prompt Builder keeps
everything it knows in two widgets, `prompt_text` and `builder_state`, so
reading those two values back is an exact copy of every field in its editor.

Nothing here touches disk: the file arrives as bytes and is parsed in memory.
"""

import io
import json
import os

BUILDER = "MiniMaxH3PromptBuilder"
IMAGE_EXT = {".png", ".webp", ".jpg", ".jpeg", ".gif", ".bmp", ".tif", ".tiff"}


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


def _links(value):
    """Every [node_id, slot] link inside an input value, nested ones included."""
    if isinstance(value, list):
        if (len(value) == 2 and isinstance(value[0], (str, int))
                and isinstance(value[1], int) and not isinstance(value[1], bool)):
            yield value
        else:
            for item in value:
                yield from _links(item)
    elif isinstance(value, dict):
        for item in value.values():
            yield from _links(item)


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


def extract(data, name):
    """The Prompt Builder fields held in a generated file, or why there are none."""
    found, errors = read_metadata(data, name)
    if not found:
        detail = f" ({'; '.join(errors)})" if errors else ""
        return {"ok": False, "error":
                "This file has no ComfyUI workflow data in it. It may have been "
                "re-encoded, edited or saved by another program." + detail}

    candidates = []
    if "prompt" in found:
        candidates = [c for c in builders_from_prompt(found["prompt"]) if _filled(c)]
    if not candidates and "workflow" in found:
        candidates = [c for c in builders_from_workflow(found["workflow"]) if _filled(c)]
    if not candidates:
        return {"ok": False, "error":
                "This file was not made with the Fantastic Prompt Builder, so "
                "there are no builder fields in it to copy."}

    # The builder that fed the render first, then the one holding the most text.
    candidates.sort(key=lambda c: (c["active"], len(c["prompt_text"])), reverse=True)
    best = candidates[0]
    return {
        "ok": True,
        "file": os.path.basename(name or ""),
        "origin": best["origin"],
        "node_id": best["id"],
        "title": best["title"],
        "prompt_text": best["prompt_text"],
        "builder_state": best["builder_state"],
        "summary": _summary(best["state"], best["prompt_text"]),
        "others": len(candidates) - 1,
    }
