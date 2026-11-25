/**
 * H3 Prompt Import
 *
 * Drop a video or image that ComfyUI generated onto the node. The Fantastic
 * Prompt Builder fields saved inside the file are copied into the nearest
 * Prompt Builder in the same graph.
 *
 * The builder keeps everything in two hidden widgets, `prompt_text` and
 * `builder_state`, so writing those two values is an exact copy of every
 * field in its editor. The file's metadata is read by the server route in
 * this pack; the file is parsed in memory and never stored.
 */
import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

const NODE_NAME = "H3PromptImport";
const BUILDER = "MiniMaxH3PromptBuilder";
const ROUTE = "/h3_prompt_import/extract";
const EDIT_BUTTON = "Edit prompt…";
const OPEN_TOGGLE = "open editor after import";
const IDLE = "Drop a generated video or image here, or click to choose one.";
const ZONE_HEIGHT = 104;

const CSS = `
.h3pi-zone { box-sizing: border-box; width: 100%; height: ${ZONE_HEIGHT}px;
  padding: 8px 10px; border: 1px dashed #6b7280; border-radius: 6px;
  font: 12px/1.35 sans-serif; color: #c9ced6; background: rgba(0,0,0,.18);
  cursor: pointer; overflow: hidden; display: flex; flex-direction: column;
  justify-content: center; gap: 3px; text-align: center; }
.h3pi-zone.hot { border-color: #3fb2a8; background: rgba(63,178,168,.14); }
.h3pi-zone.ok { border-style: solid; border-color: #3fb2a8; }
.h3pi-zone.err { border-style: solid; border-color: #f07070; }
.h3pi-zone .h3pi-main { font-weight: 600; overflow-wrap: anywhere; }
.h3pi-zone .h3pi-sub { opacity: .8; overflow-wrap: anywhere; }
.h3pi-zone.err .h3pi-main { color: #f39a9a; }
`;

function injectCSS() {
  if (document.getElementById("h3pi-css")) return;
  const style = document.createElement("style");
  style.id = "h3pi-css";
  style.textContent = CSS;
  document.head.append(style);
}

function widget(node, name) {
  return node?.widgets?.find((w) => w.name === name) || null;
}

function nodesOf(graph) {
  return graph?._nodes || graph?.nodes || [];
}

function isBuilder(n) {
  return (n?.type === BUILDER || n?.comfyClass === BUILDER) &&
    !!widget(n, "prompt_text") && !!widget(n, "builder_state");
}

function centre(n) {
  const p = n?.pos || [0, 0];
  const s = n?.size || [0, 0];
  return [p[0] + s[0] / 2, p[1] + s[1] / 2];
}

/** The Prompt Builder this node writes to: the nearest one in the same graph,
 *  falling back to the top-level graph when this graph has none. */
function findTarget(node) {
  let list = nodesOf(node.graph).filter(isBuilder);
  if (!list.length && app.graph && app.graph !== node.graph) {
    list = nodesOf(app.graph).filter(isBuilder);
  }
  if (!list.length) return { target: null, count: 0 };
  const [cx, cy] = centre(node);
  const dist = (n) => {
    const [x, y] = centre(n);
    return (x - cx) ** 2 + (y - cy) ** 2;
  };
  list.sort((a, b) => dist(a) - dist(b));
  return { target: list[0], count: list.length };
}

function hasFiles(e) {
  const types = e?.dataTransfer?.types;
  return !!types && Array.from(types).includes("Files");
}

function counted(n, one, many) {
  return `${n} ${n === 1 ? one : many}`;
}

function describe(summary) {
  if (!summary) return "";
  const parts = [summary.mode === "REF" ? "Full-reference" : String(summary.mode || "prompt")];
  if (summary.subjects) parts.push(counted(summary.subjects, "subject", "subjects"));
  if (summary.retention) parts.push(counted(summary.retention, "retention entry", "retention entries"));
  parts.push(`${Number(summary.chars || 0).toLocaleString()} characters`);
  return parts.join(" • ");
}

async function readFile(file) {
  const resp = await api.fetchApi(`${ROUTE}?name=${encodeURIComponent(file.name)}`, {
    method: "POST",
    headers: { "Content-Type": "application/octet-stream" },
    body: file,
  });
  if (resp.status === 404 || resp.status === 405) {
    throw new Error("The server part of H3 Prompt Import is not loaded. Restart ComfyUI.");
  }
  if (resp.status === 413) {
    throw new Error("That file is larger than ComfyUI's upload limit.");
  }
  let data = null;
  try { data = await resp.json(); } catch (e) { /* handled below */ }
  if (!data) throw new Error(`The server answered ${resp.status} with no data.`);
  if (!data.ok) throw new Error(data.error || "No Prompt Builder fields found in that file.");
  if (typeof data.builder_state !== "string" || !data.builder_state) {
    throw new Error("The file's Prompt Builder data is empty.");
  }
  return data;
}

function markChanged(target) {
  try { target.setDirtyCanvas?.(true, true); } catch (e) { /* Vue redraws itself */ }
  try { app.graph?.setDirtyCanvas?.(true, true); } catch (e) { /* same */ }
  try {
    app.extensionManager?.workflow?.activeWorkflow?.changeTracker?.checkState?.();
  } catch (e) { /* the tab still picks the change up on its next check */ }
}

class Importer {
  constructor(node) {
    this.node = node;
    this.previous = null;   // { id, prompt_text, builder_state } for Undo
    this.busy = false;
    injectCSS();

    this.main = document.createElement("div");
    this.main.className = "h3pi-main";
    this.sub = document.createElement("div");
    this.sub.className = "h3pi-sub";
    this.root = document.createElement("div");
    this.root.className = "h3pi-zone";
    this.root.title = "Drop a generated video or image, or click to choose one";
    this.root.append(this.main, this.sub);

    this.picker = document.createElement("input");
    this.picker.type = "file";
    this.picker.accept = "video/*,image/*";
    this.picker.style.display = "none";
    this.picker.addEventListener("change", () => {
      const files = Array.from(this.picker.files || []);
      this.picker.value = "";
      this.handle(files);
    });
    this.root.append(this.picker);

    this.root.addEventListener("click", (e) => {
      if (e.target === this.picker) return;
      this.pick();
    });
    // Handled here and stopped, so the page-level handler never sees the drop:
    // it would open the dropped file's whole workflow instead.
    this.root.addEventListener("dragover", (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault(); e.stopPropagation();
      this.root.classList.add("hot");
    });
    this.root.addEventListener("dragleave", () => this.root.classList.remove("hot"));
    this.root.addEventListener("drop", (e) => {
      if (!e.dataTransfer?.files?.length) return;
      e.preventDefault(); e.stopPropagation();
      this.root.classList.remove("hot");
      this.handle(Array.from(e.dataTransfer.files));
    });

    this.status("", IDLE, "Its Prompt Builder fields go into the nearest Prompt Builder.");
  }

  status(kind, main, sub = "") {
    this.root.classList.remove("ok", "err", "hot");
    if (kind) this.root.classList.add(kind);
    this.main.textContent = main;
    this.sub.textContent = sub;
  }

  pick() {
    if (!this.busy) this.picker.click();
  }

  async handle(files) {
    if (this.busy || !files?.length) return;
    const file = files[0];
    const { target, count } = findTarget(this.node);
    if (!target) {
      this.status("err", "No Prompt Builder in this graph.",
        "Add a Fantastic Prompt Builder node, then drop the file again.");
      return;
    }
    this.busy = true;
    this.status("", `Reading ${file.name}…`);
    try {
      const data = await readFile(file);
      this.apply(target, data);
      const notes = [describe(data.summary)];
      if (count > 1) notes.push(`nearest of ${count} Prompt Builders`);
      if (data.others) notes.push(`file held ${data.others + 1} builders, used the one that rendered`);
      if (files.length > 1) notes.push("only the first file was read");
      this.status("ok", `Copied ${file.name} into Prompt Builder #${target.id}.`,
        notes.filter(Boolean).join(" • "));
    } catch (err) {
      console.error("[H3 Prompt Import]", err);
      this.status("err", "Nothing copied.", String(err?.message || err));
    } finally {
      this.busy = false;
    }
  }

  apply(target, data) {
    const text = widget(target, "prompt_text");
    const state = widget(target, "builder_state");
    this.previous = { id: target.id, prompt_text: text.value, builder_state: state.value };
    text.value = data.prompt_text || "";
    state.value = data.builder_state;
    markChanged(target);
    this.refresh(target, !!widget(this.node, OPEN_TOGGLE)?.value);
  }

  /** Make the builder show what it now holds. Opening its editor does that
   *  and lets the fields be checked; otherwise replay its "values loaded"
   *  hook, which is what redraws the summary on the node. */
  refresh(target, openEditor) {
    try {
      const button = widget(target, EDIT_BUTTON);
      if (openEditor && button?.callback) button.callback();
      else target.onConfigure?.(target.serialize?.() ?? {});
    } catch (err) {
      console.warn("[H3 Prompt Import] values copied; the builder did not redraw:", err);
    }
  }

  undo() {
    const prev = this.previous;
    if (!prev) {
      this.status("", "Nothing to undo.", IDLE);
      return;
    }
    const graphs = [this.node.graph, app.graph].filter(Boolean);
    let target = null;
    for (const g of graphs) {
      target = g.getNodeById?.(prev.id) || nodesOf(g).find((n) => n.id === prev.id) || null;
      if (target && isBuilder(target)) break;
      target = null;
    }
    if (!target) {
      this.status("err", "Undo failed.", `Prompt Builder #${prev.id} is no longer in the graph.`);
      return;
    }
    widget(target, "prompt_text").value = prev.prompt_text;
    widget(target, "builder_state").value = prev.builder_state;
    this.previous = null;
    markChanged(target);
    this.refresh(target, false);
    this.status("", `Restored Prompt Builder #${target.id} to what it held before.`, IDLE);
  }
}

app.registerExtension({
  name: "H3.PromptImport",
  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData.name !== NODE_NAME) return;

    const onNodeCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      const r = onNodeCreated?.apply(this, arguments);
      try {
        // Canvas-only helper: never queued, never written into saved metadata.
        this.isVirtualNode = true;
        const importer = new Importer(this);
        this._h3Import = importer;
        this.addWidget("toggle", OPEN_TOGGLE, true, () => {});
        this.addWidget("button", "Choose file…", null, () => importer.pick());
        this.addWidget("button", "Undo last import", null, () => importer.undo());
        if (this.addDOMWidget) {
          const zone = this.addDOMWidget("h3_import_zone", "div", importer.root,
            { serialize: false });
          zone.computedHeight = ZONE_HEIGHT;
          zone.computeSize = () => [320, ZONE_HEIGHT];
        }
        try {
          this.size[0] = Math.max(this.size[0], 340);
          this.size[1] = Math.max(this.size[1], this.computeSize?.()[1] || 0);
        } catch (e) { /* Vue sizes it */ }
      } catch (err) {
        console.error("[H3 Prompt Import] setup failed for this node:", err);
      }
      return r;
    };

    // Drops that land on the node outside the zone (title bar, margins).
    nodeType.prototype.onDragOver = function (e) {
      return hasFiles(e);
    };
    nodeType.prototype.onDragDrop = function (e) {
      const files = Array.from(e?.dataTransfer?.files || []);
      if (!files.length || !this._h3Import) return false;
      this._h3Import.handle(files);
      return true;
    };
  },
});
