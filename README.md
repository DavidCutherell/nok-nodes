# nok-nodes

A ComfyUI custom node pack that collects small tools. Each tool lives in its own folder, and the pack loads all of them.

## Tools

| Tool | Node | What it does |
|---|---|---|
| [h3_prompt_import](h3_prompt_import/) | H3 Prompt Import (drop a video or image) | Drop a video or image that ComfyUI generated onto the node. It reads the prompt saved inside the file, shows it next to what your workflow holds now, and copies over the parts you tick. |

## H3 Prompt Import

ComfyUI stores the graph it ran inside every video and image it saves. This tool reads the prompt back out of such a file and lets you put it, or parts of it, into the workflow on your canvas. It works with any prompt tool, from a plain text encoder to the Fantastic Prompt Builder.

### Start from a prompt you already have

If you do not want to type a whole prompt out again, you do not have to. Drop a render you liked onto the node, copy its prompt into your workflow, and change only what should be different. A long, structured prompt is a lot of typing, and most new prompts are an old one with a few parts changed.

The side by side view is built for this. You can keep the subject and style sections you have now and take only the description from an old render, or the other way round.

### Using it

1. Add the node. Find it under **conditioning/video_models**, or search for "H3 Prompt Import".
2. Drop a generated file on the node, or click the node to choose one. MP4, PNG, WebP and JPEG are read, including files saved by Video Helper Suite.
3. A dialog opens and lists every prompt text found in the file. Nothing has been copied yet.
4. For each text, choose a destination in **Copy to**, or leave it on **Do not copy**.
5. Where the destination already holds text, tick what to keep from each side.
6. Press **Copy**. **Cancel** or Escape copies nothing.

**Undo last import** on the node puts back everything the last import changed.

### Choosing where each text goes

Each text found in the file has its own **Copy to** list:

- **Do not copy** leaves that text out.
- Every canvas node of the same type is offered. Choosing one copies all of that node's fields.
- Every other node with a text box is offered as "text only", notes included.

Destinations are labelled positive or negative when the canvas wiring shows which they are. The lists start on the automatic match described further down, so you can accept it or change any row. Two texts cannot be sent to the same node.

### Side by side: keep or overwrite, part by part

Once a destination is chosen, the dialog shows what that destination holds now on the left and what the file brings on the right, cut into parts. Each side of each part has a tick box.

- It starts with everything from the file ticked, which is a plain overwrite.
- **Keep everything current** and **Take everything from the file** set all the boxes at once.
- The **Result** line opens a preview of exactly what will be written. It updates as you tick.
- Parts that are identical on both sides are marked and need no choice.
- An empty destination has nothing to compare, so the file's text is shown alone.

How the parts and tick boxes work depends on the destination:

| Destination | The parts | What the tick boxes allow |
|---|---|---|
| Fantastic Prompt Builder | Its sections: subject definitions, summary, retention analysis, style and description, soundscape, music. Plain modes have description, soundscape and music, plus a mode and timing row when those differ. | One side per section, since a section holds one version. Unticking both sides of an optional section switches it off, as in the builder's own editor. Summary and description must come from one side. |
| A text box | Blocks separated by blank lines. Blocks that open with the same `label:` on both sides are lined up. The rest are lined up in order. | Any mix. A part ticked on both sides is kept twice, current first, which is how to append. |
| Another prompt tool, all its fields | One row per setting. | One side per setting. |

For the Fantastic Prompt Builder, a section is swapped by taking its text block and its saved editor fields from the same side. The builder's editor then shows the same mix the prompt holds. Taking everything from one side gives back that side's fields exactly. Two limits apply:

- A prompt in full-reference mode and one in a plain mode cannot be mixed section by section. They can only be swapped whole.
- Section text can refer to a subject by name. If the subject definitions come from one side, other sections come from the other, and the two sides name their subjects differently, the dialog warns that names in the text may not match.

### Options on the node

| Option | What it does |
|---|---|
| **open editor after import** | After copying, shows the result. A tool with its own editor has it opened. A plain text node is selected, brought into view if it was off screen, and its text box focused. |
| **copy into** | `ask me where each text goes` is the default and opens the dialog. `matching nodes (auto)` applies the automatic match at once, with no dialog. `the selected node` sends the prompt to the one node you selected, with no dialog. |
| **Choose file…** | Opens a file picker, the same as clicking the drop area. |
| **Undo last import** | Puts back everything the last import changed. |

### How the prompt is found in the file

The server starts at every text encoder in the saved graph, meaning every node that outputs conditioning, and follows its text inputs back to where the text was typed. That can be the encoder itself, a prompt builder, a text node, or a chain of them. Each such node is labelled positive or negative when the graph shows which sampler input it reaches.

How much of a node is offered depends on what kind of node it is:

| Node in the file | What can be copied |
|---|---|
| Fantastic Prompt Builder (`MiniMaxH3PromptBuilder`) | `prompt_text` and `builder_state`, which hold every field in its editor: subjects, summary, retention, style, description, soundscape and music |
| Another prompt tool that feeds a text encoder | All of its settings, by widget name |
| A text encoder with the text typed into it | Its text only, so sizes and other settings on the canvas stay as they are |

### The automatic match

This is the starting selection in the dialog, and what the `matching nodes (auto)` option applies directly. For each prompt node found in the file:

1. A canvas node of the same type gets that node's fields. Among several of the same type, the one with the same node id wins, then the same title, then the same positive or negative role, then the nearest.
2. If the canvas has no node of that type, the main prompt text goes into the best prompt text box on the canvas. Nodes named for prompts rank first, then text encoders. Notes and preview nodes are skipped.
3. Positive and negative are never crossed. Negative text only goes into a box known to be negative. In the dialog you may cross them by hand.

A value is left alone when the widget is driven by a link, or when it is a choice that is not installed here, such as a missing LoRA name. The status line says how many were skipped.

### Good to know

- The file is posted to a route on your own ComfyUI, `POST /h3_prompt_import/extract`, parsed in memory, and not stored. The server log records the file name and how many prompt nodes were found, never the prompt.
- The node never runs. It is marked virtual, so it stays out of the queued graph and out of the metadata of new renders.
- A file that was re-encoded or edited by another program has lost its ComfyUI data and cannot be read.
- The search uses the node definitions installed in the ComfyUI that reads the file. For node types that are not installed, it falls back to node and input names, which finds less.
- Plain text cannot fill a structured tool. A text from a plain text encoder is not offered the Fantastic Prompt Builder as a destination, because the builder rebuilds its prompt from its own saved fields.
- A file whose saver kept only the canvas and not the executed graph can be read only if it holds a Fantastic Prompt Builder.
- It needs no extra Python packages beyond what ComfyUI ships (PyAV, Pillow, aiohttp).

### Teaching it a new prompt tool

Most tools need nothing. A tool whose editor must be opened or refreshed in a special way, or whose prompt has sections that should be compared one by one, gets an entry in `ADAPTERS` at the top of `web/h3_prompt_import.js`.

## Install

Clone the repo into ComfyUI's `custom_nodes` folder, then restart ComfyUI:

```
cd <ComfyUI>/custom_nodes
git clone https://github.com/DavidCutherell/nok-nodes.git
```

To work on the pack, keep the clone anywhere and link it in instead, so your edits are what ComfyUI loads. On Windows:

```powershell
New-Item -ItemType Junction -Path "<ComfyUI>\custom_nodes\nok-nodes" -Target "<path to your clone>"
```

Restart ComfyUI after installing and after any Python change. Browser-side changes in `web/` only need a page reload.

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
4. Add tests under `tests/<tool>/` and a row in the tools table above.

## Tests

Run from the repo root. The Python tests need PyAV, Pillow and aiohttp, so use ComfyUI's own interpreter. Running them is safe while ComfyUI is up, and nothing is installed.

```powershell
& "<ComfyUI>\.venv\Scripts\python.exe" tests\h3_prompt_import\test_extract.py
node tests\h3_prompt_import\js\run.mjs
```

All samples are synthetic and built in memory. To also check real renders, pass their paths to the Python test:

```powershell
& "<ComfyUI>\.venv\Scripts\python.exe" tests\h3_prompt_import\test_extract.py "D:\path\to\render.mp4"
```

The browser test can also check that real Prompt Builder prompts split into sections and go back together exactly. Point `NOK_REAL_SAMPLES` at a JSON file holding an array of `{ "prompt_text": ..., "builder_state": ... }` objects taken from real renders. Keep that file out of the repo.

```powershell
$env:NOK_REAL_SAMPLES = "D:\path\to\samples.json"; node tests\h3_prompt_import\js\run.mjs
```

Both scripts print one PASS or FAIL line per check and end with `FAILS <count>`. They print lengths, ids and counts only, never prompt text.
