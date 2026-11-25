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
    removed: false, remove() { this.removed = true; },
    replaceChildren(...kids) { this.children = kids; },
  };
}
globalThis.document = { createElement: makeEl, getElementById: () => null, head: makeEl("head"), body: makeEl("body") };

const { app } = await load("scripts", "app.js");
const { api } = await load("scripts", "api.js");
const { __test } = await load("extensions", "nok-nodes", "h3_prompt_import.js");

let fails = 0;
const check = (label, cond, info = "") => { if (!cond) fails++; console.log((cond ? "PASS " : "FAIL ") + label, info); };
const respond = (status, body) => async () => ({ status, json: async () => body });
const tick = () => new Promise((r) => setTimeout(r, 0));

// ---- what the server route answers (see extract.py)
const BUILDER = "MiniMaxH3PromptBuilder";
const STATE = JSON.stringify({ version: 3, mode: "REF", ref: { subjectDefs: [{ text: "a", name: "Subject 1", role: "main" }], retention: [] } });
const builderAnswer = {
  ok: true, file: "ComfyUI_test_00035_.mp4", origin: "prompt",
  nodes: [{ id: "220", type: BUILDER, title: "Prompt Builder", role: null, text_field: "prompt_text",
    summary: { mode: "REF", subjects: 1, retention: 0, chars: 38 },
    values: { prompt_text: "New prompt text from the dropped file.", builder_state: STATE } }],
};
const classicAnswer = {
  ok: true, file: "image.png", origin: "prompt",
  nodes: [
    { id: "6", type: "CLIPTextEncode", title: "Positive", role: "positive", text_field: "text", values: { text: "new positive text" } },
    { id: "7", type: "CLIPTextEncode", title: "Negative", role: "negative", text_field: "text", values: { text: "new negative text" } },
  ],
};
const toolAnswer = {
  ok: true, file: "tool.png", origin: "prompt",
  nodes: [{ id: "1", type: "StylePrompt", title: "", role: "positive", text_field: "text",
    values: { text: "styled text", preset: "film", strength: 0.8, lora: "missing.safetensors", linked: "from file" } }],
};

// ---- canvas stand-ins
function builder(id, pos) {
  const n = {
    id, type: BUILDER, pos, size: [330, 200], edits: 0, configures: 0, dirty: 0,
    widgets: [
      { name: "prompt_text", value: `old text ${id}`, callback() { throw new Error("a quiet tool's handlers must not run"); } },
      { name: "builder_state", value: `{"version":1,"mode":"T2VA","old":${id}}` },
    ],
    setDirtyCanvas() { this.dirty++; },
    serialize() { return { id: this.id, widgets_values: this.widgets.map((w) => w.value) }; },
    onConfigure(info) { if (!info || info.id !== this.id) throw new Error("bad info"); this.configures++; },
  };
  n.widgets.push({ name: "Edit prompt…", type: "button", value: null, callback: () => { n.edits++; } });
  return n;
}
function textNode(id, type, title, pos, text = `old ${id}`) {
  const w = { name: "text", type: "customtext", value: text, changes: 0, inputEl: { tagName: "TEXTAREA", focused: 0, focus() { this.focused++; } } };
  w.callback = () => { w.changes++; };
  return { id, type, title, pos, size: [300, 150], widgets: [w], inputs: [{ name: "clip", link: 1 }], outputs: [{ links: [] }], text: w };
}
function makeGraph(nodes, wires = []) {      // wires: [from node, to node, input name]
  const g = { _nodes: nodes, links: {}, getNodeById(id) { return this._nodes.find((n) => n.id === id); } };
  wires.forEach(([from, to, name], i) => {
    to.inputs ||= [];
    to.inputs.push({ name, link: 100 + i });
    g.links[100 + i] = { target_id: to.id, target_slot: to.inputs.length - 1 };
    from.outputs[0].links.push(100 + i);
  });
  nodes.forEach((n) => { n.graph = g; });
  return g;
}
const canvas = { selected_nodes: {}, selects: [], centred: [], visible_area: [0, 0, 2000, 2000],
  selectNode(n) { this.selects.push(n.id); }, centerOnNode(n) { this.centred.push(n.id); } };
app.canvas = canvas;
function use(graph) { app.graph = graph; canvas.graph = graph; canvas.selects = []; canvas.centred = []; canvas.selected_nodes = {}; }

const ext = app.extensions[0];
check("extension registered", app.extensions.length === 1 && ext.name === "H3.PromptImport");
function OtherType() {}
await ext.beforeRegisterNodeDef(OtherType, { name: "SomethingElse" });
check("other node types untouched", OtherType.prototype.onDragDrop === undefined);
function NodeType() {}
await ext.beforeRegisterNodeDef(NodeType, { name: "H3PromptImport" });

// Sections 1 to 13 test the automatic modes; section 14 tests the default, which asks.
function makeImporter(graph, pos = [0, 0], mode = "matching nodes (auto)") {
  const node = new NodeType();
  Object.assign(node, {
    id: 300, type: "H3PromptImport", pos, size: [200, 80], graph, widgets: [], dom: [],
    addWidget(type, name, value, callback, options) { const w = { type, name, value, callback, options }; this.widgets.push(w); return w; },
    addDOMWidget(name, type, element, opts) { const w = { name, element, opts }; this.dom.push(w); return w; },
    computeSize() { return [340, 260]; },
  });
  node.onNodeCreated();
  const target = node.widgets.find((w) => w.name === "copy into");
  node.modeAsCreated = target.value;
  target.value = mode;
  graph._nodes.push(node);
  return node;
}
const file = { name: "ComfyUI_test_00035_.mp4" };
const dropEvent = () => ({ prevented: 0, stopped: 0, dataTransfer: { files: [file], types: ["Files"] }, preventDefault() { this.prevented++; }, stopPropagation() { this.stopped++; } });

// ======================================================= Fantastic Prompt Builder
const near = builder(220, [400, 0]);
const far = builder(999, [5000, 5000]);
const bare = { id: 5, type: BUILDER, pos: [0, 0], size: [1, 1], widgets: [] };
let graph = makeGraph([far, bare, near]);
use(graph);
let node = makeImporter(graph);
let imp = node._h3Import;
const button = (name) => node.widgets.find((w) => w.name === name);
check("node built", !!imp && node.isVirtualNode === true && node.dom.length === 1 && node.dom[0].opts.serialize === false &&
  node.widgets.map((w) => w.name).join("|") === "open editor after import|Choose file…|Undo last import|copy into",
  `widgets ${node.widgets.map((w) => w.name).join(" | ")}`);
check("target option defaults to asking and sits last", node.modeAsCreated === "ask me where each text goes" &&
  button("copy into").options.values.join("|") === "ask me where each text goes|matching nodes (auto)|the selected node");
check("idle text shown", imp.main.textContent.startsWith("Drop a generated"));

// 1. Drop on the zone, editor toggle on.
api.next = respond(200, builderAnswer);
let e = dropEvent();
imp.root.fire("drop", e);
await tick(); await tick();
check("drop is swallowed", e.prevented === 1 && e.stopped === 1);
check("request shape", api.calls.length === 1 && api.calls[0].url === "/h3_prompt_import/extract?name=ComfyUI_test_00035_.mp4" && api.calls[0].opts.method === "POST" && api.calls[0].opts.body === file);
check("builder with the file's node id got both fields", near.widgets[0].value === builderAnswer.nodes[0].values.prompt_text && near.widgets[1].value === STATE);
check("other builder untouched", far.widgets[0].value === "old text 999");
check("editor opened once, no configure replay", near.edits === 1 && near.configures === 0 && near.dirty >= 1);
check("status ok", imp.root.classList.contains("ok") && imp.main.textContent === "Copied ComfyUI_test_00035_.mp4 into Prompt Builder #220.", "| " + imp.sub.textContent);
check("builder summary shown", imp.sub.textContent.startsWith("Full-reference • 1 subject • 38 characters"));

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
check("copied without opening editor", near.widgets[1].value === STATE && near.edits === 1 && near.configures === 2);
check("onDragDrop without files declines", node.onDragDrop({ dataTransfer: { files: [] } }) === false);

// 4. Failures leave the canvas alone.
button("Undo last import").callback();
const before = near.widgets.map((w) => w.value).join("|");
for (const [label, fn, want] of [
  ["route missing", respond(404, null), "Restart ComfyUI"],
  ["too large", respond(413, null), "upload limit"],
  ["no prompt in file", respond(200, { ok: false, error: "no prompt text was found in it" }), "no prompt text"],
  ["server older than page", respond(200, { ok: true, prompt_text: "x", builder_state: "{}" }), "older than this page"],
  ["empty node list", respond(200, { ok: true, nodes: [] }), "empty"],
  ["network error", async () => { throw new Error("Fetch timeout"); }, "Fetch timeout"],
]) {
  api.next = fn;
  const origErr = console.error; console.error = () => {};
  await imp.handle([file]);
  console.error = origErr;
  check(`failure: ${label}`, imp.root.classList.contains("err") && imp.sub.textContent.includes(want) && near.widgets.map((w) => w.value).join("|") === before && imp.busy === false);
}

// 5. A file from another workflow: no id match, so the nearest builder is used and that is said.
api.next = respond(200, { ...builderAnswer, nodes: [{ ...builderAnswer.nodes[0], id: "151:77" }] });
await imp.handle([file]);
check("no id match: nearest builder, flagged as a guess", near.widgets[1].value === STATE && far.widgets[0].value === "old text 999" &&
  imp.sub.textContent.includes("nearest of 2 Prompt Builder nodes"), "| " + imp.sub.textContent);

// 6. The importer sits in a subgraph that has no builder: the rest of the workflow is searched.
const inner = makeGraph([]);
const sub = makeImporter(inner);
sub.graph = inner;
inner.rootGraph = graph;
api.next = respond(200, builderAnswer);
near.widgets[1].value = "x";
await sub._h3Import.handle([file]);
check("searches beyond its own graph", near.widgets[1].value === STATE);

// 7. Clicking the zone opens the file picker.
imp.root.fire("click", { target: imp.root });
check("click opens picker", imp.picker.clicks === 1);

// ======================================================= any prompt tool
// 8. Same node type on the canvas, other ids: positive and negative each go to the right box.
let pos = textNode(41, "CLIPTextEncode", "CLIP Text Encode", [300, 0]);
let neg = textNode(42, "CLIPTextEncode", "CLIP Text Encode", [10, 0]);       // nearer, but negative
let note = textNode(43, "MarkdownNote", "Note", [20, 0]);
let sampler = { id: 44, type: "KSampler", pos: [700, 0], size: [200, 200], widgets: [], inputs: [], outputs: [{ links: [] }] };
graph = makeGraph([pos, neg, note, sampler], [[pos, sampler, "positive"], [neg, sampler, "negative"]]);
use(graph);
node = makeImporter(graph);
imp = node._h3Import;
api.next = respond(200, classicAnswer);
await imp.handle([file]);
check("positive text into the positive encoder", pos.text.value === "new positive text" && pos.text.changes === 1);
check("negative text into the negative encoder", neg.text.value === "new negative text" && neg.text.changes === 1);
check("note untouched", note.text.value === "old 43");
check("status names both nodes", imp.main.textContent === "Copied ComfyUI_test_00035_.mp4 into 2 nodes: CLIP Text Encode #41, CLIP Text Encode #42.", "| " + imp.sub.textContent);
check("plain text node is selected and focused, not moved to", canvas.selects.join() === "41" && canvas.centred.length === 0 && pos.text.inputEl.focused === 1);
button2("Undo last import").callback();
check("undo restores both nodes", pos.text.value === "old 41" && neg.text.value === "old 42" && imp.main.textContent.startsWith("Restored CLIP Text Encode #41, CLIP Text Encode #42 to what they held"));
function button2(name) { return node.widgets.find((w) => w.name === name); }

// 9. Builder file, canvas without a builder: the prompt text goes into the positive text box.
api.next = respond(200, builderAnswer);
canvas.visible_area = [5000, 5000, 100, 100];        // the target is off screen this time
await imp.handle([file]);
check("text-only fallback into the positive prompt box", pos.text.value === builderAnswer.nodes[0].values.prompt_text && neg.text.value === "old 42" && note.text.value === "old 43");
check("  said so", imp.main.textContent.endsWith("into CLIP Text Encode #41.") && imp.sub.textContent.includes("text only, no Prompt Builder node here"), "| " + imp.sub.textContent);
check("  off-screen target is brought into view", canvas.centred.join() === "41");
canvas.visible_area = [0, 0, 2000, 2000];

// 10. Negative text from another kind of encoder only ever lands in a negative box.
const negativeOnly = { ...classicAnswer, nodes: [{ ...classicAnswer.nodes[1], type: "OtherEncode" }] };
api.next = respond(200, negativeOnly);
pos.text.value = "keep me";
await imp.handle([file]);
check("negative text goes to the negative box, not the positive one", neg.text.value === "new negative text" && pos.text.value === "keep me", "| " + imp.sub.textContent);
graph.links[101].target_slot = 99;                      // unplug the negative encoder: now no box is known to be negative
neg.text.value = "keep me too";
let origErr = console.error; console.error = () => {};
await imp.handle([file]);
console.error = origErr;
check("negative text with no negative box: nothing written", pos.text.value === "keep me" && neg.text.value === "keep me too" && imp.root.classList.contains("err"), "| " + imp.sub.textContent.slice(0, 60));
graph.links[101].target_slot = sampler.inputs.length - 1;

// 11. "the selected node" mode.
button2("copy into").value = "the selected node";
api.next = respond(200, builderAnswer);
origErr = console.error; console.error = () => {};
await imp.handle([file]);
console.error = origErr;
check("selected mode with nothing selected: asks for a selection", imp.root.classList.contains("err") && imp.sub.textContent.startsWith("Select one node"));
canvas.selected_nodes = { 43: note };
await imp.handle([file]);
check("selected mode: text goes to the selected node, even a note", note.text.value === builderAnswer.nodes[0].values.prompt_text && pos.text.value === "keep me");
canvas.selected_nodes = { 44: sampler };
origErr = console.error; console.error = () => {};
await imp.handle([file]);
console.error = origErr;
check("selected mode: a node without a text box is refused", imp.root.classList.contains("err") && imp.sub.textContent.includes("no prompt text box"));
canvas.selected_nodes = { 42: neg };
api.next = respond(200, classicAnswer);
await imp.handle([file]);
check("selected mode: same type gets its best-matching entry", neg.text.value === "new positive text");
button2("copy into").value = "matching nodes (auto)";

// 12. A prompt tool with settings: every field by name, except what cannot be set here.
const tool = {
  id: 60, type: "StylePrompt", title: "Style", pos: [0, 300], size: [300, 200], outputs: [{ links: [] }], calls: [],
  inputs: [{ name: "linked", widget: { name: "linked" }, link: 9 }],
  widgets: [
    { name: "text", type: "customtext", value: "old", options: { multiline: true } },
    { name: "preset", type: "combo", value: "anime", options: { values: ["film", "anime"] } },
    { name: "strength", type: "number", value: 0.5 },
    { name: "lora", type: "combo", value: "here.safetensors", options: { values: ["here.safetensors"] } },
    { name: "linked", type: "customtext", value: "driven by a link" },
    { name: "Open prompt editor", type: "button", value: null, callback() { tool.calls.push("editor"); } },
  ],
};
tool.widgets.forEach((w) => { if (w.type !== "button") w.callback = (v) => tool.calls.push(`${w.name}=${v}`); });
graph = makeGraph([tool]);
use(graph);
node = makeImporter(graph);
imp = node._h3Import;
api.next = respond(200, toolAnswer);
await imp.handle([file]);
const val = (name) => tool.widgets.find((w) => w.name === name).value;
check("tool fields copied by name", val("text") === "styled text" && val("preset") === "film" && val("strength") === 0.8);
check("  a choice that is not installed here is left alone and counted", val("lora") === "here.safetensors" && imp.sub.textContent.includes("1 value was not available here"), "| " + imp.sub.textContent);
check("  a field driven by a link is left alone", val("linked") === "driven by a link");
check("  change handlers ran, then the tool's own editor button", tool.calls.join() === "text=styled text,preset=film,strength=0.8,editor", tool.calls.join());

// 13. Plain text from the file never goes into a structured tool's hidden text store.
const lone = builder(70, [0, 0]);
lone.widgets[0].type = "customtext";                    // even if its store looks like a text box
graph = makeGraph([lone]);
use(graph);
node = makeImporter(graph);
imp = node._h3Import;
api.next = respond(200, classicAnswer);
origErr = console.error; console.error = () => {};
await imp.handle([file]);
node.widgets.find((w) => w.name === "copy into").value = "the selected node";
canvas.selected_nodes = { 70: lone };
const first = imp.sub.textContent;
await imp.handle([file]);
console.error = origErr;
check("plain text is not pushed into a Prompt Builder", lone.widgets[0].value === "old text 70" && first.startsWith("No node on this canvas") &&
  imp.sub.textContent.includes("no prompt text box"), "| " + imp.sub.textContent.slice(0, 70));

// ======================================================= asking where each text goes (the default)
const ASK = "ask me where each text goes";
pos = textNode(41, "CLIPTextEncode", "CLIP Text Encode", [300, 0]);
neg = textNode(42, "CLIPTextEncode", "CLIP Text Encode", [10, 0]);
note = textNode(43, "MarkdownNote", "Note", [20, 0]);
sampler = { id: 44, type: "KSampler", pos: [700, 0], size: [200, 200], widgets: [], inputs: [], outputs: [{ links: [] }] };
graph = makeGraph([pos, neg, note, sampler], [[pos, sampler, "positive"], [neg, sampler, "negative"]]);
use(graph);
node = makeImporter(graph, [0, 0], ASK);
imp = node._h3Import;
const chosenLabel = (row) => (row.select.value === "" ? "Do not copy" : row.options[Number(row.select.value)].label);
const pickLabel = (row, text) => { row.select.value = String(row.options.findIndex((o) => o.label.startsWith(text))); row.select.fire("change", {}); };
const untouched = () => pos.text.value === "old 41" && neg.text.value === "old 42" && note.text.value === "old 43";

// 14. The dialog opens, nothing is written, and the automatic match is only the starting selection.
api.next = respond(200, classicAnswer);
let pending = imp.handle([file]);
await tick(); await tick();
let dlg = imp.chooser;
check("ask: a dialog opens and nothing is written yet", !!dlg && untouched() && document.body.children.at(-1) === dlg.overlay && imp.busy === true, "| " + imp.main.textContent);
check("ask: one row per text in the file, each showing the current text next to the file's", dlg.rows.length === 2 &&
  dlg.rows.map((row) => row.model.rows.map((x) => `${x.old}>${x.neu}`).join()).join("|") === "old 41>new positive text|old 42>new negative text");
check("ask: starts on the automatic match", chosenLabel(dlg.rows[0]) === "CLIP Text Encode #41 (positive)" && chosenLabel(dlg.rows[1]) === "CLIP Text Encode #42 (negative)",
  `${chosenLabel(dlg.rows[0])} | ${chosenLabel(dlg.rows[1])}`);
check("ask: every text box is offered, with its role", dlg.rows[0].options.map((o) => o.label).join(" / ") ===
  "CLIP Text Encode #41 (positive) / CLIP Text Encode #42 (negative) / Note #43, text only", dlg.rows[0].options.map((o) => o.label).join(" / "));

// 15. Two texts into one node is refused; choosing nothing is refused; the dialog stays open.
pickLabel(dlg.rows[1], "CLIP Text Encode #41");
dlg.apply();
check("ask: two texts into one node is refused", dlg.problem.textContent.startsWith("Two texts point at CLIP Text Encode #41") && untouched() && !dlg.overlay.removed);
dlg.rows.forEach((r) => { r.select.value = ""; r.select.fire("change", {}); });
check("ask: changing a choice clears the message and dims a left-out row", dlg.problem.textContent === "" && dlg.overlay.children[0].children[2].children[0].classList.contains("off"));
dlg.apply();
check("ask: choosing nothing is refused", dlg.problem.textContent.startsWith("Nothing is chosen") && !dlg.overlay.removed);

// 16. Keep one text, leave the other out, and send it somewhere the automatic match would not.
pickLabel(dlg.rows[0], "Note #43");
dlg.overlay.children[0].children[3].children[2].fire("click", {});          // the Copy button
await pending;
check("ask: the kept text goes where it was sent, the other is left out", note.text.value === "new positive text" && pos.text.value === "old 41" && neg.text.value === "old 42");
check("ask: dialog closed and the result is reported", dlg.overlay.removed && imp.chooser === null && imp.busy === false &&
  imp.main.textContent === "Copied ComfyUI_test_00035_.mp4 into Note #43." && imp.sub.textContent.includes("1 of 2 texts copied"), "| " + imp.sub.textContent);
node.widgets.find((w) => w.name === "Undo last import").callback();
check("ask: undo restores", untouched());

// 17. Cancel, by button and by Escape.
api.next = respond(200, classicAnswer);
pending = imp.handle([file]);
await tick(); await tick();
dlg = imp.chooser;
dlg.overlay.children[0].children[3].children[1].fire("click", {});          // the Cancel button
await pending;
check("ask: Cancel copies nothing", untouched() && dlg.overlay.removed && imp.main.textContent === "Cancelled. Nothing copied." && imp.busy === false);
pending = imp.handle([file]);
await tick(); await tick();
dlg = imp.chooser;
const key = { key: "Escape", stopped: 0, stopPropagation() { this.stopped++; } };
dlg.overlay.fire("keydown", key);
await pending;
check("ask: Escape cancels and the key does not reach the canvas", untouched() && dlg.overlay.removed && key.stopped === 1);

// 18. A negative text may be sent to a positive box when the person says so.
pending = imp.handle([file]);
await tick(); await tick();
dlg = imp.chooser;
dlg.rows[0].select.value = "";
pickLabel(dlg.rows[1], "CLIP Text Encode #41");
dlg.apply();
await pending;
check("ask: a hand-made choice may cross positive and negative", pos.text.value === "new negative text" && neg.text.value === "old 42");

// 19. A builder file on a builder canvas: the builder is offered with all its fields.
const b1 = builder(220, [400, 0]);
const plain = textNode(41, "CLIPTextEncode", "CLIP Text Encode", [300, 0]);
graph = makeGraph([b1, plain]);
use(graph);
node = makeImporter(graph, [0, 0], ASK);
imp = node._h3Import;
api.next = respond(200, builderAnswer);
pending = imp.handle([file]);
await tick(); await tick();
dlg = imp.chooser;
check("ask: builder row offers the builder with all its fields, then text boxes", dlg.rows.length === 1 &&
  dlg.rows[0].options.map((o) => o.label).join(" / ") === "Prompt Builder #220, all its fields / CLIP Text Encode #41, text only" &&
  chosenLabel(dlg.rows[0]).startsWith("Prompt Builder #220"), dlg.rows[0].options.map((o) => o.label).join(" / "));
check("ask: row heading names the source and its size", dlg.overlay.children[0].children[2].children[0].children[0].textContent === "Prompt text" &&
  dlg.overlay.children[0].children[2].children[0].children[0].children[0].textContent === " from Prompt Builder #220 • Full-reference • 1 subject • 38 characters");
dlg.apply();
await pending;
check("ask: builder gets both fields and its editor opens", b1.widgets[1].value === STATE && b1.edits === 1 && plain.text.value === "old 41");

// 20. Nowhere to put anything: no dialog, a clear message.
graph = makeGraph([{ id: 44, type: "KSampler", pos: [0, 0], size: [1, 1], widgets: [], inputs: [], outputs: [{ links: [] }] }]);
use(graph);
node = makeImporter(graph, [0, 0], ASK);
imp = node._h3Import;
api.next = respond(200, classicAnswer);
origErr = console.error; console.error = () => {};
await imp.handle([file]);
console.error = origErr;
check("ask: no possible destination gives a message, not an empty dialog", imp.root.classList.contains("err") && imp.sub.textContent.startsWith("No node on this canvas") && imp.chooser === null && imp.busy === false);

// ======================================================= side by side: keep current or take from the file
const { splitSections, alignSections, textModel, builderModel } = __test;
const takeAll = (model, side) => model.rows.map((r) => (r.same ? { old: true, neu: true }
  : { old: side === "old" && r.old != null, neu: side === "neu" && r.neu != null }));

// 21. Cutting text into parts and lining the two sides up.
check("parts: blank lines split, labels are read", JSON.stringify(splitSections("summary:\nA\n\n \nplain words\r\n\r\nStyle notes: B")) ===
  JSON.stringify([{ label: "summary", text: "summary:\nA" }, { label: null, text: "plain words" }, { label: "style notes", text: "Style notes: B" }]));
let al = alignSections("p1\n\np2\n\np3", "n1\n\nn2");
check("parts: unlabelled parts pair up in order, the extra one stays", al.map((r) => `${r.old}|${r.neu}`).join(" ") === "p1|n1 p2|n2 p3|null");
al = alignSections("summary:\nA\n\nstyle: B\n\nextra", "style: B2\n\nsummary:\nA\n\nmusic: M");
check("parts: labelled parts pair by label, in the file's order", al.map((r) => `${r.label}:${r.old != null}/${r.neu != null}`).join(" ") ===
  "style:true/true null:true/false summary:true/true music:false/true", al.map((r) => `${r.label}:${r.old != null}/${r.neu != null}`).join(" "));

// 22. Plain text: any mix of parts from either side.
const OLD_T = "p1\n\np2\n\np3", NEW_T = "n1\n\n\nn2  ";
let tm = textModel(OLD_T, NEW_T);
check("text: titles and sides", tm.rows.map((r) => `${r.title}=${r.old}|${r.neu}`).join(" ") === "Part 1=p1|n1 Part 2=p2|n2 Part 3=p3|null");
check("text: everything from the file is the file's text exactly, spacing included", tm.compose(takeAll(tm, "neu")) === NEW_T);
check("text: everything current is the current text exactly", tm.compose(takeAll(tm, "old")) === OLD_T);
check("text: a mix keeps the parts in place", tm.compose([{ old: true, neu: false }, { old: false, neu: true }, { old: true, neu: false }]) === "p1\n\nn2\n\np3");
check("text: ticking both sides keeps both, current first", tm.compose([{ old: true, neu: true }, { old: false, neu: false }, { old: false, neu: false }]) === "p1\n\nn1");
check("text: nothing to compare against an empty destination", textModel("  \n", NEW_T) === null);
tm = textModel("one line", "another line");
check("text: unsectioned text is one part called Whole text, and both sides can be kept", tm.rows.length === 1 && tm.rows[0].title === "Whole text" &&
  tm.compose([{ old: true, neu: true }]) === "one line\n\nanother line");
tm = textModel("keep\n\nold tail", "keep\n\nnew tail");
check("text: an identical part is marked same", tm.rows[0].same === true && tm.rows[1].same === false && tm.compose([{ old: true, neu: true }, { old: true, neu: false }]) === "keep\n\nold tail");

// 23. Fantastic Prompt Builder: section by section, text and saved fields together.
const refText = (s) => {
  const r = s.ref, off = s.off || {}, b = [];
  if (!off.subject_definitions) b.push("subject_definitions:\n" + r.subjectDefs.map((d) => d.text).join("\n"));
  b.push(`summary:\n[reference generation] ${r.summaryText}`);
  if (!off.retention_analysis) b.push("retention_analysis:\n" + r.retention.map((x) => `${x.label}: ${x.marker} - ${x.note}`).join("\n"));
  b.push(`detailed_description:\n${r.styleLine}\n${r.detail}`);
  if (!off.overall_soundscape) b.push(`overall_soundscape:\n${r.soundscape}`);
  if (!off.non_diegetic_music) b.push(`non_diegetic_music:\n${r.music}`);
  return b.join("\n\n");
};
const refState = (tag, off = {}) => ({ version: 3, mode: "REF", off, duration: 8, imd: `${tag} base text`, soundscape: "", music: "N/A",
  ref: { subjectDefs: [{ text: `<Subject 1> is ${tag} person.`, name: "", role: "main" }], summaryTypes: ["reference generation"], summaryText: `${tag} summary`,
    retention: [{ label: "<Picture 1>", context: "", marker: "keep", note: `${tag} note` }], styleLine: `${tag} style`, detail: `${tag} detail\n\nsecond ${tag} paragraph`,
    soundscape: `${tag} rain`, music: "N/A" } });
const vals = (state) => ({ prompt_text: refText(state), builder_state: JSON.stringify(state) });
const OLD_V = vals(refState("old")), NEW_V = vals(refState("new", { retention_analysis: true }));
let bm = builderModel(OLD_V, NEW_V);
const rowOf = (m, title) => m.rows.findIndex((r) => r.title === title);
check("builder: one row per section", bm.rows.map((r) => r.title).join("|") === "Subject definitions|Summary|Retention analysis|Style and description|Soundscape|Music");
check("builder: sides show the section text without its label", bm.rows[1].old === "[reference generation] old summary" && bm.rows[1].neu === "[reference generation] new summary" &&
  bm.rows[3].old === "old style\nold detail\n\nsecond old paragraph");
check("builder: a section the file has switched off has no file side; identical sections are marked same", bm.rows[2].neu === null && bm.rows[2].old !== null && bm.rows[5].same === true && bm.rows[0].same === false);
check("builder: optional and required sections", bm.rows.map((r) => (r.required ? "R" : "o")).join("") === "oRoRoo" && bm.rows.every((r) => r.exclusive));
let out = bm.compose(takeAll(bm, "neu"));
check("builder: everything from the file is the file's two fields exactly", out.prompt_text === NEW_V.prompt_text && out.builder_state === NEW_V.builder_state);
out = bm.compose(takeAll(bm, "old"));
check("builder: everything current is the current two fields exactly", out.prompt_text === OLD_V.prompt_text && out.builder_state === OLD_V.builder_state);
let picks = takeAll(bm, "old");
picks[rowOf(bm, "Summary")] = { old: false, neu: true };
picks[rowOf(bm, "Soundscape")] = { old: false, neu: false };
out = bm.compose(picks);
let st = JSON.parse(out.builder_state);
check("builder mix: the saved fields follow the picks", st.ref.summaryText === "new summary" && st.ref.subjectDefs[0].text === "<Subject 1> is old person." &&
  st.ref.detail.startsWith("old detail") && st.ref.retention[0].note === "old note" && st.imd === "old base text");
check("builder mix: unticking both sides switches the section off but keeps its words", st.off.overall_soundscape === true && st.ref.soundscape === "old rain" && !st.off.retention_analysis);
check("builder mix: the prompt is rebuilt from the picked sections, in order", out.prompt_text === [
  "subject_definitions:\n<Subject 1> is old person.", "summary:\n[reference generation] new summary", "retention_analysis:\n<Picture 1>: keep - old note",
  "detailed_description:\nold style\nold detail\n\nsecond old paragraph", "non_diegetic_music:\nN/A"].join("\n\n"));
check("builder mix: the result is what the builder itself would write for those fields", out.prompt_text === refText(st));
picks = takeAll(bm, "neu");
picks[rowOf(bm, "Retention analysis")] = { old: true, neu: false };
st = JSON.parse((out = bm.compose(picks)).builder_state);
check("builder mix: keeping a section the file had switched off switches it back on", !st.off.retention_analysis && st.ref.retention[0].note === "old note" &&
  st.ref.summaryText === "new summary" && out.prompt_text === refText(st));
const baseState = { version: 3, mode: "I2VA", off: {}, duration: 5, p2Shot: 1, lastShot: 1, imd: "base words", soundscape: "wind", music: "N/A", ref: refState("x").ref };
const BASE_V = { prompt_text: "For the target video, at 0.00 seconds.\n\nintegrated_multimodal_description: base words\n\noverall_soundscape: wind\n\nnon_diegetic_music: N/A", builder_state: JSON.stringify(baseState) };
bm = builderModel(OLD_V, BASE_V);
check("builder: different modes cannot be mixed, only swapped whole", bm.rows.length === 1 && bm.rows[0].title === "Whole prompt" && !!bm.hint &&
  bm.compose([{ old: false, neu: true }]).builder_state === BASE_V.builder_state && bm.compose([{ old: true, neu: false }]).prompt_text === OLD_V.prompt_text);
const base2 = { ...baseState, mode: "T2VA", duration: 10, imd: "other words" };
const BASE2_V = { prompt_text: "integrated_multimodal_description: other words\n\noverall_soundscape: wind\n\nnon_diegetic_music: N/A", builder_state: JSON.stringify(base2) };
bm = builderModel(BASE_V, BASE2_V);
check("builder: plain modes get a mode and timing row", bm.rows.map((r) => r.title).join("|") === "Mode and timing|Description|Soundscape|Music" && bm.rows[2].same && bm.rows[0].old.startsWith("I2VA, 5 seconds\nFor the target"));
picks = takeAll(bm, "old"); picks[0] = { old: false, neu: true };
st = JSON.parse((out = bm.compose(picks)).builder_state);
check("builder: taking mode and timing alone", st.mode === "T2VA" && st.duration === 10 && st.imd === "base words" && out.prompt_text.startsWith("integrated_multimodal_description: base words"));
// The two sides name their subjects differently: mixing subjects with text from the other side is flagged.
const namedState = refState("new"); namedState.ref.subjectDefs[0].name = "Tester";
bm = builderModel(OLD_V, vals(namedState));
picks = takeAll(bm, "neu");
check("builder: no warning while one side supplies everything", bm.warn(picks) === "" && bm.warn(takeAll(bm, "old")) === "");
picks[rowOf(bm, "Subject definitions")] = { old: true, neu: false };
check("builder: subjects from one side and text from the other is flagged when names differ", bm.warn(picks).startsWith("The subject definitions come from one side"));
bm = builderModel(OLD_V, NEW_V);
picks = takeAll(bm, "neu"); picks[0] = { old: true, neu: false };
check("builder: the same mix is not flagged when both sides name subjects alike", bm.warn(picks) === "");
check("builder: an empty builder has nothing to compare", builderModel({ prompt_text: "", builder_state: "{}" }, NEW_V) === null);

// 24. In the dialog: a builder file onto a builder that already holds a prompt.
const b2 = builder(220, [400, 0]);
b2.widgets[0].value = OLD_V.prompt_text; b2.widgets[1].value = OLD_V.builder_state;
graph = makeGraph([b2]);
use(graph);
node = makeImporter(graph, [0, 0], ASK);
imp = node._h3Import;
const fileBuilder = { ok: true, file: "x.mp4", origin: "prompt", nodes: [{ ...builderAnswer.nodes[0], values: NEW_V }] };
api.next = respond(200, fileBuilder);
pending = imp.handle([file]);
await tick(); await tick();
dlg = imp.chooser;
let r0 = dlg.rows[0];
const ticks = (row) => row.model.rows.map((r, i) => (r.same ? "=" : `${row.boxes[i].old.checked ? "C" : "-"}${row.boxes[i].neu.checked ? "F" : "-"}`)).join(" ");
check("dialog: the builder's sections are shown side by side, starting on the file", r0.model.rows.length === 6 && ticks(r0) === "-F -F -- -F -F =", ticks(r0));
check("dialog: both sides and the result are on the page", r0.panel.children[1].children.map((c) => c.textContent).join("|") === "Current in Prompt Builder #220|From the file" &&
  r0.resultText.textContent === NEW_V.prompt_text && r0.boxes[2].neu.disabled === true);
r0.boxes[0].old.checked = true; r0.boxes[0].old.fire("change", {});          // keep the current subjects
check("dialog: a section holds one version, so ticking one side unticks the other", ticks(r0) === "C- -F -- -F -F =" && r0.boxes[0].oldWrap.classList.contains("picked") && !r0.boxes[0].neuWrap.classList.contains("picked"));
dlg.toggle(r0, 1, "neu", false);
check("dialog: a section that must be there falls to the other side when unticked", ticks(r0) === "C- C- -- -F -F =");
dlg.toggle(r0, 1, "old", false);
check("dialog: and back again", ticks(r0) === "C- -F -- -F -F =");
dlg.toggle(r0, 4, "neu", false);
check("dialog: an optional section can be left out by unticking both", ticks(r0) === "C- -F -- -F -- =" && !r0.resultText.textContent.includes("overall_soundscape"));
check("dialog: no name warning for sides that name subjects alike", r0.warning.textContent === "");
check("dialog: the result preview follows the ticks", r0.resultText.textContent.startsWith("subject_definitions:\n<Subject 1> is old person.\n\nsummary:\n[reference generation] new summary") &&
  r0.resultTitle.textContent.startsWith("Result: "));
dlg.apply();
await pending;
st = JSON.parse(b2.widgets[1].value);
check("dialog: the builder receives the mix in both of its fields", st.ref.subjectDefs[0].text === "<Subject 1> is old person." && st.ref.summaryText === "new summary" && st.ref.detail.startsWith("new detail") &&
  st.off.overall_soundscape === true && st.off.retention_analysis === true && b2.widgets[0].value === refText(st) && b2.edits === 1);
node.widgets.find((w) => w.name === "Undo last import").callback();
check("dialog: undo puts the builder back", b2.widgets[0].value === OLD_V.prompt_text && b2.widgets[1].value === OLD_V.builder_state);

// 25. In the dialog: keeping everything current changes nothing, and says so.
api.next = respond(200, fileBuilder);
pending = imp.handle([file]);
await tick(); await tick();
dlg = imp.chooser;
dlg.rows[0].panel.children[0].children[0].fire("click", {});                 // "Keep everything current"
check("dialog: keep-everything button ticks the current side", ticks(dlg.rows[0]) === "C- C- C- C- C- =", ticks(dlg.rows[0]));
dlg.apply();
await pending;
check("dialog: nothing changed is reported as such", b2.widgets[1].value === OLD_V.builder_state && imp.main.textContent === "Nothing changed." && !imp.root.classList.contains("ok"));

// 26. In the dialog: plain text into a text box that already holds text, part by part.
const boxNode = textNode(41, "CLIPTextEncode", "CLIP Text Encode", [300, 0], "p1\n\np2\n\np3");
const otherBox = textNode(45, "PrimitiveStringMultiline", "String", [900, 0], "");
graph = makeGraph([boxNode, otherBox]);
use(graph);
node = makeImporter(graph, [0, 0], ASK);
imp = node._h3Import;
const fileText = { ok: true, file: "t.png", origin: "prompt", nodes: [{ id: "9", type: "CLIPTextEncode", title: "", role: null, text_field: "text", values: { text: "n1\n\nn2" } }] };
api.next = respond(200, fileText);
pending = imp.handle([file]);
await tick(); await tick();
dlg = imp.chooser;
r0 = dlg.rows[0];
check("dialog: text parts side by side, starting on the file", r0.model.rows.length === 3 && ticks(r0) === "-F -F --" && r0.boxes[2].neu.disabled === true && r0.resultText.textContent === "n1\n\nn2", ticks(r0));
dlg.toggle(r0, 0, "old", true);
dlg.toggle(r0, 2, "old", true);
check("dialog: plain text parts can be kept from both sides at once", ticks(r0) === "CF -F C-" && r0.resultText.textContent === "p1\n\nn1\n\nn2\n\np3");
dlg.toggle(r0, 0, "neu", false);
r0.select.value = String(r0.options.findIndex((o) => o.node === otherBox)); r0.select.fire("change", {});
check("dialog: an empty destination has no comparison, only the file's text", r0.model === null && r0.panel.children.length === 2 && r0.panel.children[1].textContent === "n1\n\nn2");
r0.select.value = String(r0.options.findIndex((o) => o.node === boxNode)); r0.select.fire("change", {});
check("dialog: changing the destination redraws the comparison from the start", ticks(r0) === "-F -F --");
dlg.toggle(r0, 0, "old", true); dlg.toggle(r0, 0, "neu", false); dlg.toggle(r0, 2, "old", true);
dlg.apply();
await pending;
check("dialog: the text box receives the mix", boxNode.text.value === "p1\n\nn2\n\np3" && otherBox.text.value === "" && imp.root.classList.contains("ok"));

// 27. In the dialog: a prompt tool with several settings, one row per setting.
const tool2 = {
  id: 60, type: "StylePrompt", title: "Style", pos: [0, 300], size: [300, 200], outputs: [{ links: [] }], inputs: [],
  widgets: [
    { name: "text", type: "customtext", value: "current words", options: { multiline: true } },
    { name: "preset", type: "combo", value: "anime", options: { values: ["film", "anime"] } },
    { name: "strength", type: "number", value: 0.8 },
    { name: "lora", type: "combo", value: "here.safetensors", options: { values: ["here.safetensors"] } },
  ],
};
graph = makeGraph([tool2]);
use(graph);
node = makeImporter(graph, [0, 0], ASK);
imp = node._h3Import;
api.next = respond(200, { ...toolAnswer, nodes: [{ ...toolAnswer.nodes[0], values: { text: "styled text", preset: "film", strength: 0.8, lora: "missing.safetensors" } }] });
pending = imp.handle([file]);
await tick(); await tick();
dlg = imp.chooser;
r0 = dlg.rows[0];
check("dialog: one row per setting; same and unavailable values are marked", r0.model.rows.map((r) => r.title).join("|") === "text|preset|strength|lora" &&
  r0.model.rows[2].same === true && r0.model.rows[3].neu === null && r0.boxes[3].neu.disabled === true && ticks(r0) === "-F -F = C-", ticks(r0));
dlg.toggle(r0, 1, "old", true);
dlg.apply();
await pending;
const val2 = (name) => tool2.widgets.find((w) => w.name === name).value;
check("dialog: only the ticked settings are taken", val2("text") === "styled text" && val2("preset") === "anime" && val2("lora") === "here.safetensors");

// ======================================================= optional: real builder values
// NOK_REAL_SAMPLES=<file> points at a JSON array of { prompt_text, builder_state } taken from real
// renders. Checks that real prompts split into sections and go back together exactly.
// Prints counts only, never the text.
if (process.env.NOK_REAL_SAMPLES) {
  const real = JSON.parse(fs.readFileSync(process.env.NOK_REAL_SAMPLES, "utf8"));
  const ORDER = ["subject_definitions", "summary", "retention_analysis", "detailed_description", "overall_soundscape", "non_diegetic_music"];
  let whole = 0, ordered = 0, exact = 0, mixed = 0, pairs = 0, rowsSeen = 0;
  for (const v of real) {
    const { head, blocks } = __test.builderBlocks(v.prompt_text);
    if ([head, ...Object.values(blocks)].filter(Boolean).join("\n\n") === v.prompt_text) whole++;
    const keys = Object.keys(blocks);
    if (keys.every((k, i) => i === 0 || ORDER.indexOf(k) > ORDER.indexOf(keys[i - 1]))) ordered++;
  }
  for (let i = 0; i + 1 < real.length; i++) {
    const a = real[i], b = real[i + 1];
    const m = builderModel(a, b);
    if (!m || m.rows.length < 2) continue;
    pairs++;
    rowsSeen += m.rows.length;
    const n = m.compose(takeAll(m, "neu")), o = m.compose(takeAll(m, "old"));
    if (n.prompt_text === b.prompt_text && n.builder_state === b.builder_state && o.prompt_text === a.prompt_text && o.builder_state === a.builder_state) exact++;
    const s = rowOf(m, "Summary");
    if (s < 0 || m.rows[s].same) { mixed++; continue; }
    const p = takeAll(m, "old"); p[s] = { old: false, neu: true };
    const mix = m.compose(p);
    const state = JSON.parse(mix.builder_state);
    const want = a.prompt_text.replace(__test.builderBlocks(a.prompt_text).blocks.summary, () => __test.builderBlocks(b.prompt_text).blocks.summary);
    if (mix.prompt_text === want && state.ref.summaryText === JSON.parse(b.builder_state).ref.summaryText &&
        JSON.stringify(state.ref.subjectDefs) === JSON.stringify(JSON.parse(a.builder_state).ref.subjectDefs)) mixed++;
  }
  check("real: every prompt splits into sections and joins back exactly", whole === real.length, `${whole} of ${real.length}`);
  check("real: sections come in the expected order", ordered === real.length, `${ordered} of ${real.length}`);
  check("real: all-from-file and all-current give back the exact two fields", exact === pairs && pairs > 0, `${exact} of ${pairs} pairs, ${rowsSeen} section rows`);
  check("real: swapping only the summary changes only the summary", mixed === pairs, `${mixed} of ${pairs} pairs`);
}

console.log("FAILS", fails);
process.exit(fails ? 1 : 0);
