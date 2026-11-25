// Tests for the H3 Prompt Import tool (browser side), without a browser.
//
//   node tests/h3_prompt_import/js/run.mjs
//
// The extension imports ComfyUI's "../../scripts/app.js". To satisfy that, the
// real web file is copied into a throwaway folder shaped like ComfyUI's URLs,
// next to small stand-ins for app.js and api.js.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "..", "..", "..");
const box = fs.mkdtempSync(path.join(os.tmpdir(), "nok-nodes-jstest-"));
fs.mkdirSync(path.join(box, "scripts"));
fs.mkdirSync(path.join(box, "extensions", "nok-nodes"), { recursive: true });
fs.writeFileSync(path.join(box, "package.json"), '{"type": "module"}');
fs.copyFileSync(path.join(here, "stubs", "app.js"), path.join(box, "scripts", "app.js"));
fs.copyFileSync(path.join(here, "stubs", "api.js"), path.join(box, "scripts", "api.js"));
fs.copyFileSync(path.join(repo, "web", "h3_prompt_import.js"), path.join(box, "extensions", "nok-nodes", "h3_prompt_import.js"));
process.on("exit", () => fs.rmSync(box, { recursive: true, force: true }));
const load = (...parts) => import(pathToFileURL(path.join(box, ...parts)).href);

function makeEl(tag) {
  const cls = new Set();
  return {
    tag, style: {}, children: [], listeners: {}, textContent: "", className: "", value: "", files: [],
    classList: { add: (...c) => c.forEach((x) => cls.add(x)), remove: (...c) => c.forEach((x) => cls.delete(x)), contains: (c) => cls.has(c) },
    append(...kids) { this.children.push(...kids); },
    addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); },
    fire(type, e) { (this.listeners[type] || []).forEach((fn) => fn(e)); },
    clicks: 0, click() { this.clicks++; },
  };
}
globalThis.document = { createElement: makeEl, getElementById: () => null, head: makeEl("head") };

const { app } = await load("scripts", "app.js");
const { api } = await load("scripts", "api.js");
await load("extensions", "nok-nodes", "h3_prompt_import.js");

let fails = 0;
const check = (label, cond, info = "") => { if (!cond) fails++; console.log((cond ? "PASS " : "FAIL ") + label, info); };
// What the server route answers for a good file (see extract.py).
const answer = {
  ok: true, file: "ComfyUI_test_00035_.mp4", origin: "prompt", node_id: "220", title: "Prompt Builder",
  prompt_text: "New prompt text from the dropped file.",
  builder_state: JSON.stringify({ version: 3, mode: "REF", ref: { subjectDefs: [{ text: "a", name: "Subject 1", role: "main" }], retention: [] } }),
  summary: { mode: "REF", subjects: 1, retention: 0, chars: 38 }, others: 0,
};
const respond = (status, body) => async () => ({ status, json: async () => body });
const tick = () => new Promise((r) => setTimeout(r, 0));

function builder(id, pos) {
  const n = {
    id, type: "MiniMaxH3PromptBuilder", pos, size: [330, 200], edits: 0, configures: 0, dirty: 0,
    widgets: [
      { name: "prompt_text", value: `old text ${id}` },
      { name: "builder_state", value: `{"version":1,"mode":"T2VA","old":${id}}` },
    ],
    setDirtyCanvas() { this.dirty++; },
    serialize() { return { id: this.id, widgets_values: this.widgets.map((w) => w.value) }; },
    onConfigure(info) { if (!info || info.id !== this.id) throw new Error("bad info"); this.configures++; },
  };
  n.widgets.push({ name: "Edit prompt…", value: null, callback: () => { n.edits++; } });
  return n;
}
const near = builder(220, [400, 0]);
const far = builder(999, [5000, 5000]);
const bare = { id: 5, type: "MiniMaxH3PromptBuilder", pos: [0, 0], size: [1, 1], widgets: [] };
const graph = { _nodes: [far, bare, near], getNodeById(id) { return this._nodes.find((n) => n.id === id); } };
app.graph = graph;

const ext = app.extensions[0];
check("extension registered", app.extensions.length === 1 && ext.name === "H3.PromptImport");

function OtherType() {}
await ext.beforeRegisterNodeDef(OtherType, { name: "SomethingElse" });
check("other node types untouched", OtherType.prototype.onDragDrop === undefined);

function NodeType() {}
await ext.beforeRegisterNodeDef(NodeType, { name: "H3PromptImport" });
const node = new NodeType();
Object.assign(node, {
  id: 300, pos: [0, 0], size: [200, 80], graph, widgets: [], dom: [],
  addWidget(type, name, value, callback) { const w = { type, name, value, callback }; this.widgets.push(w); return w; },
  addDOMWidget(name, type, element, opts) { const w = { name, element, opts }; this.dom.push(w); return w; },
  computeSize() { return [340, 260]; },
});
node.onNodeCreated();
const imp = node._h3Import;
check("node built", !!imp && node.isVirtualNode === true && node.widgets.length === 3 && node.dom.length === 1 && node.dom[0].opts.serialize === false,
  `widgets ${node.widgets.map((w) => w.name).join(" | ")} size ${node.size}`);
check("idle text shown", imp.main.textContent.startsWith("Drop a generated"));

const file = { name: "ComfyUI_test_00035_.mp4" };
const dropEvent = () => ({ prevented: 0, stopped: 0, dataTransfer: { files: [file], types: ["Files"] }, preventDefault() { this.prevented++; }, stopPropagation() { this.stopped++; } });
const button = (name) => node.widgets.find((w) => w.name === name);

// 1. Drop on the zone, editor toggle on.
api.next = respond(200, answer);
let e = dropEvent();
imp.root.fire("drop", e);
await tick(); await tick();
check("drop is swallowed", e.prevented === 1 && e.stopped === 1);
check("request shape", api.calls.length === 1 && api.calls[0].url === "/h3_prompt_import/extract?name=ComfyUI_test_00035_.mp4" && api.calls[0].opts.method === "POST" && api.calls[0].opts.body === file);
check("nearest builder got both fields", near.widgets[0].value === answer.prompt_text && near.widgets[1].value === answer.builder_state);
check("far builder untouched", far.widgets[0].value === "old text 999");
check("editor opened once, no configure replay", near.edits === 1 && near.configures === 0 && near.dirty >= 1);
check("status ok", imp.root.classList.contains("ok") && imp.main.textContent === "Copied ComfyUI_test_00035_.mp4 into Prompt Builder #220.", "| " + imp.sub.textContent);

// 2. Undo.
button("Undo last import").callback();
check("undo restores", near.widgets[0].value === "old text 220" && near.widgets[1].value.includes('"old":220') && near.configures === 1 && near.edits === 1, imp.main.textContent);
button("Undo last import").callback();
check("second undo is a no-op", imp.main.textContent === "Nothing to undo." && near.widgets[0].value === "old text 220");

// 3. Toggle off, drop on the node body (title bar path).
button("open editor after import").value = false;
check("onDragOver", node.onDragOver(dropEvent()) === true && node.onDragOver({ dataTransfer: { types: ["text/plain"] } }) === false);
check("onDragDrop claims the drop", node.onDragDrop(dropEvent()) === true);
await tick(); await tick();
check("copied without opening editor", near.widgets[1].value === answer.builder_state && near.edits === 1 && near.configures === 2);
check("onDragDrop without files declines", node.onDragDrop({ dataTransfer: { files: [] } }) === false);

// 4. Failures leave the builder alone.
button("Undo last import").callback();
const before = near.widgets.map((w) => w.value).join("|");
for (const [label, fn, want] of [
  ["route missing", respond(404, null), "Restart ComfyUI"],
  ["too large", respond(413, null), "upload limit"],
  ["no builder data", respond(200, { ok: false, error: "This file was not made with the Fantastic Prompt Builder" }), "not made with"],
  ["empty state", respond(200, { ok: true, prompt_text: "x", builder_state: "" }), "empty"],
  ["network error", async () => { throw new Error("Fetch timeout"); }, "Fetch timeout"],
]) {
  api.next = fn;
  const origErr = console.error; console.error = () => {};
  await imp.handle([file]);
  console.error = origErr;
  check(`failure: ${label}`, imp.root.classList.contains("err") && imp.sub.textContent.includes(want) && near.widgets.map((w) => w.value).join("|") === before && imp.busy === false);
}

// 5. No builder in the graph.
graph._nodes = [bare];
api.next = respond(200, answer);
const callsBefore = api.calls.length;
await imp.handle([file]);
check("no builder: clear message, no upload", imp.main.textContent === "No Prompt Builder in this graph." && api.calls.length === callsBefore);

// 6. Importer inside a subgraph with no builder falls back to the top-level graph.
graph._nodes = [far, near];
node.graph = { _nodes: [node] };
await imp.handle([file]);
check("falls back to top-level graph", near.widgets[1].value === answer.builder_state && imp.sub.textContent.includes("nearest of 2"));

// 7. Clicking the zone opens the file picker.
imp.root.fire("click", { target: imp.root });
check("click opens picker", imp.picker.clicks === 1);

console.log("FAILS", fails);
process.exit(fails ? 1 : 0);
