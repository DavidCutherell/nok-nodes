# nok-nodes

A ComfyUI custom node pack that collects small tools. Each tool lives in its own folder, and the pack loads all of them.

## Tools

| Tool | Node | What it does |
|---|---|---|
| [h3_prompt_import](h3_prompt_import/) | H3 Prompt Import (drop a video or image) | Drop a file that ComfyUI generated onto the node. The Fantastic Prompt Builder fields saved inside the file are copied into the nearest Prompt Builder on the canvas. |

### H3 Prompt Import

ComfyUI stores the graph it ran inside every video and image it saves. The Fantastic Prompt Builder (`MiniMaxH3PromptBuilder`) keeps all of its fields in two widgets, `prompt_text` and `builder_state`. This tool reads those two values back out of a dropped file and writes them into the Prompt Builder, which restores every field in its editor: subjects, summary, retention, style, description, soundscape and music.

- Find it under **conditioning/video_models**, or search for "H3 Prompt Import".
- Drop a file on the node, or click it to choose one. MP4, PNG, WebP and JPEG are read, including files saved by Video Helper Suite.
- The file is posted to a local route, `POST /h3_prompt_import/extract`, parsed in memory, and not stored. The server log records the file name and the outcome, never the prompt.
- The node never runs. It is marked virtual, so it stays out of the queued graph and out of the metadata of new renders.
- **Undo last import** puts back what the Prompt Builder held before.
- A file that was re-encoded or edited by another program has lost its ComfyUI data and cannot be read.

It needs the Fantastic pack's Prompt Builder on the canvas. It needs no extra Python packages beyond what ComfyUI ships (PyAV, Pillow, aiohttp).

## Install

The pack has to appear as one folder inside ComfyUI's `custom_nodes`. For development, link the repo instead of copying it, so edits here are what ComfyUI loads:

```powershell
New-Item -ItemType Junction -Path "<ComfyUI>\custom_nodes\nok-nodes" -Target "C:\code\comfy-tools\nok-nodes"
```

Restart ComfyUI after installing and after any Python change. Browser-side changes in `web/` only need a page reload.

Do not load this pack next to an older standalone copy of one of its tools. Both would register the same node name and the same route.

## Layout

```
nok-nodes/
  __init__.py            finds every tool folder and merges its nodes
  h3_prompt_import/      one tool: __init__.py (node + route), extract.py
  web/                   browser code for all tools, one file per tool, kept flat
  tests/<tool>/          tests for that tool
```

## Adding a tool

1. Create a folder at the repo root with an `__init__.py` that defines `NODE_CLASS_MAPPINGS`, and `NODE_DISPLAY_NAME_MAPPINGS` if wanted. The pack picks it up on the next start. A tool that fails to import is logged and skipped, and the others still load.
2. Put its browser code in `web/<tool>.js`. Keep files flat in `web/`, because the usual imports `../../scripts/app.js` and `../../scripts/api.js` only resolve from that depth.
3. Give node class names and server routes a tool-specific prefix so tools cannot collide.
4. Add tests under `tests/<tool>/` and a row in the table above.

## Tests

Run from the repo root. The Python tests need PyAV, Pillow and aiohttp, so use ComfyUI's own interpreter. Running it is safe while ComfyUI is up; nothing is installed.

```powershell
& "<ComfyUI>\.venv\Scripts\python.exe" tests\h3_prompt_import\test_extract.py
node tests\h3_prompt_import\js\run.mjs
```

All samples are synthetic and built in memory. To also check real renders, pass their paths to the Python test:

```powershell
& "<ComfyUI>\.venv\Scripts\python.exe" tests\h3_prompt_import\test_extract.py "D:\path\to\render.mp4"
```

Both scripts print one PASS or FAIL line per check and end with `FAILS <count>`. They print lengths and ids only, never prompt text.
