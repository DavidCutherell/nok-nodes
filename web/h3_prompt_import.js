/**
 * H3 Prompt Import
 *
 * Drop a video or image that ComfyUI generated onto the node. The prompt texts
 * saved inside the file can then be copied into the prompt nodes on the
 * canvas, whatever prompt tool the workflow uses.
 *
 * By default nothing is copied until the person has chosen: a dialog lists
 * each text found in the file with a "copy to" list of every node on the
 * canvas that could take it, and "do not copy". The list starts on the
 * automatic match:
 *
 *  - A canvas node of the same type as a prompt node in the file gets that
 *    node's fields back by name. For the Fantastic Prompt Builder that is an
 *    exact copy of every field in its editor.
 *  - If the canvas has no node of that type, the main prompt text goes into
 *    the best prompt text box on the canvas.
 *
 * Once a destination is chosen the dialog shows, side by side, what it holds
 * now and what the file brings, part by part with a tick box on each side, so
 * any mix of current and new can be kept. The Prompt Builder is compared
 * section by section, a text box block by block, another tool field by field.
 *
 * "copy into" on the node can skip the dialog: "matching nodes (auto)" applies
 * the automatic match at once, "the selected node" writes to the selected node.
 *
 * The file's metadata is read by the server route in this pack; the file is
 * parsed in memory and never stored.
 */
import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

const NODE_NAME = "H3PromptImport";
const ROUTE = "/h3_prompt_import/extract";
const OPEN_TOGGLE = "open editor after import";
const TARGET_MODE = "copy into";
const MODE_ASK = "ask me where each text goes";
const MODE_AUTO = "matching nodes (auto)";
const MODE_SELECTED = "the selected node";
const IDLE = "Drop a generated video or image here, or click to choose one.";
const IDLE_SUB = "You then choose which of its prompt texts to keep and where each goes.";
const ZONE_HEIGHT = 104;
// Widget names that usually hold prompt text, most likely first.
const TEXT_NAMES = ["prompt_text", "prompt", "text", "positive", "string", "value",
  "text_g", "text_l", "t5xxl", "clip_l", "caption", "description"];
const NOT_A_PROMPT = /note|preview|show|display/i;

/** Tools that need more than "write the widget values" to show what they hold. */
const ADAPTERS = {
  MiniMaxH3PromptBuilder: {
    label: "Prompt Builder",
    quiet: true,        // its two widgets are hidden stores, not inputs with change handlers
    structured: true,   // plain text cannot fill it: the text is rebuilt from its saved fields
    open(node) {
      const button = widget(node, "Edit prompt…");
      if (!button?.callback) return false;
      button.callback();
      return true;
    },
    // Replays the "values loaded" hook, which redraws the summary on the node.
    refresh(node) { node.onConfigure?.(node.serialize?.() ?? {}); },
    // Its prompt is built from sections, so current and new can be mixed section by section.
    compare: (current, incoming) => builderModel(current, incoming),
  },
};

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
.h3pi-overlay { position: fixed; inset: 0; z-index: 10000; background: rgba(0,0,0,.55);
  display: flex; align-items: center; justify-content: center; }
.h3pi-dialog { box-sizing: border-box; width: min(1180px, 95vw); max-height: 90vh;
  display: flex; flex-direction: column; gap: 10px; padding: 16px 18px;
  background: #1f2228; color: #dfe3ea; border: 1px solid #3a3f4a; border-radius: 10px;
  font: 13px/1.4 sans-serif; box-shadow: 0 18px 60px rgba(0,0,0,.6); outline: none; }
.h3pi-dialog h3 { margin: 0; font-size: 15px; overflow-wrap: anywhere; }
.h3pi-dialog .h3pi-hint { margin: 0; opacity: .75; }
.h3pi-rows { overflow-y: auto; display: flex; flex-direction: column; gap: 10px; padding-right: 4px; }
.h3pi-row { border: 1px solid #3a3f4a; border-radius: 8px; padding: 9px 10px;
  display: flex; flex-direction: column; gap: 6px; background: rgba(255,255,255,.03); }
.h3pi-row.off { opacity: .55; }
.h3pi-row-head { font-weight: 600; overflow-wrap: anywhere; }
.h3pi-row-head .h3pi-from { font-weight: 400; opacity: .75; }
.h3pi-text { margin: 0; max-height: 170px; overflow: auto; white-space: pre-wrap;
  overflow-wrap: anywhere; font: 12px/1.4 sans-serif; padding: 6px 8px; border-radius: 6px;
  background: rgba(0,0,0,.28); user-select: text; }
.h3pi-dest { display: flex; align-items: center; gap: 8px; }
.h3pi-dest select { flex: 1; min-width: 0; padding: 4px 6px; border-radius: 6px;
  background: #14161a; color: inherit; border: 1px solid #4a5060; font: inherit; }
.h3pi-panel { display: flex; flex-direction: column; gap: 8px; }
.h3pi-panel .h3pi-hint { opacity: .75; }
.h3pi-pair { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
.h3pi-col-title { font-weight: 600; opacity: .85; overflow-wrap: anywhere; }
.h3pi-sec { display: flex; flex-direction: column; gap: 4px; }
.h3pi-sec-title { font-weight: 600; }
.h3pi-sec-title .h3pi-from { font-weight: 400; opacity: .7; }
.h3pi-side { display: flex; align-items: flex-start; gap: 6px; padding: 5px; border-radius: 7px;
  border: 1px solid transparent; cursor: pointer; min-width: 0; opacity: .6; }
.h3pi-side.picked { border-color: #3fb2a8; background: rgba(63,178,168,.10); opacity: 1; }
.h3pi-side input { margin-top: 4px; flex: none; }
.h3pi-side .h3pi-text { flex: 1; min-width: 0; }
.h3pi-dim { opacity: .6; }
.h3pi-quick { display: flex; gap: 8px; flex-wrap: wrap; }
.h3pi-quick button { padding: 3px 10px; border-radius: 6px; border: 1px solid #4a5060;
  background: #2a2e37; color: inherit; font: inherit; cursor: pointer; }
.h3pi-warning { color: #f0c070; }
.h3pi-warning:empty { display: none; }
.h3pi-result summary { cursor: pointer; opacity: .85; }
.h3pi-result .h3pi-text { margin-top: 5px; max-height: 240px; }
.h3pi-foot { display: flex; align-items: center; gap: 8px; }
.h3pi-foot .h3pi-problem { flex: 1; color: #f39a9a; }
.h3pi-foot button { padding: 6px 14px; border-radius: 6px; border: 1px solid #4a5060;
  background: #2a2e37; color: inherit; font: inherit; cursor: pointer; }
.h3pi-foot button.h3pi-go { background: #2f8f87; border-color: #3fb2a8; color: #fff; }
`;

function injectCSS() {
  if (document.getElementById("h3pi-css")) return;
  const style = document.createElement("style");
  style.id = "h3pi-css";
  style.textContent = CSS;
  document.head.append(style);
}

// ---------------------------------------------------------------- canvas helpers

function widget(node, name) {
  return node?.widgets?.find((w) => w.name === name) || null;
}

function nodesOf(graph) {
  return graph?._nodes || graph?.nodes || [];
}

function typeOf(n) {
  return n?.comfyClass || n?.type || "";
}

function labelOf(n) {
  return `${ADAPTERS[typeOf(n)]?.label || n.title || typeOf(n)} #${n.id}`;
}

function centre(n) {
  const p = n?.pos || [0, 0];
  const s = n?.size || [0, 0];
  return [p[0] + s[0] / 2, p[1] + s[1] / 2];
}

function distance(a, b) {
  const [ax, ay] = centre(a);
  const [bx, by] = centre(b);
  return (ax - bx) ** 2 + (ay - by) ** 2;
}

/** Every graph of this workflow: the importer's own first, then the one on
 *  screen, the top level, and all subgraphs. */
function allGraphs(node) {
  const root = node.graph?.rootGraph || app.graph?.rootGraph || app.graph;
  let subs = [];
  try {
    const held = root?.subgraphs;
    subs = held?.values ? Array.from(held.values()) : [];
  } catch (e) { /* no subgraphs */ }
  return [...new Set([node.graph, app.canvas?.graph, root, app.graph, ...subs].filter(Boolean))];
}

/** A widget this tool may write: not a button, and not driven by a link. */
function writable(node, w) {
  if (!w || w.type === "button") return false;
  return !node.inputs?.some((i) => i?.widget?.name === w.name && i.link != null);
}

function isTextBox(w) {
  const tag = (w?.inputEl || w?.element)?.tagName;
  return w?.type === "customtext" || w?.options?.multiline === true || tag === "TEXTAREA";
}

/** The multiline text box of a node that prompt text should go into. */
function textBox(node) {
  const boxes = (node?.widgets || []).filter((w) => isTextBox(w) && writable(node, w));
  const rank = (w) => {
    const i = TEXT_NAMES.indexOf(String(w.name).toLowerCase());
    return i < 0 ? TEXT_NAMES.length : i;
  };
  return boxes.sort((a, b) => rank(a) - rank(b))[0] || null;
}

/** 'positive' / 'negative' / null, by which input this node's output reaches. */
function canvasRole(node, graph) {
  const linkOf = (id) => graph?.getLink?.(id) ?? graph?.links?.get?.(id) ?? graph?.links?.[id];
  const byId = (id) => graph?.getNodeById?.(id) ?? nodesOf(graph).find((n) => n.id === id);
  const seen = new Set([node]);
  let frontier = [node];
  const hits = new Set();
  for (let depth = 0; depth < 8 && frontier.length && !hits.size; depth++) {
    const following = [];
    for (const source of frontier) {
      for (const output of source.outputs || []) {
        for (const id of output?.links || []) {
          const link = linkOf(id);
          const target = link && byId(link.target_id);
          if (!target) continue;
          const name = String(target.inputs?.[link.target_slot]?.name || "").toLowerCase();
          if (name.includes("negative") || name === "neg" || name === "uncond") hits.add("negative");
          else if (name.includes("positive") || name === "pos" || name === "cond") hits.add("positive");
          else if (!seen.has(target)) { seen.add(target); following.push(target); }
        }
      }
    }
    frontier = following;
  }
  return hits.has("positive") ? "positive" : hits.size ? "negative" : null;
}

/** Whether a value can go into a widget: a listed choice, or the same kind of value. */
function fitsWidget(w, value) {
  const listed = w.options?.values;
  return w.type === "combo" && Array.isArray(listed) ? listed.includes(value)
    : w.value == null || typeof w.value === typeof value;
}

function make(tag, className, text) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text != null) el.textContent = text;
  return el;
}

function hasFiles(e) {
  const types = e?.dataTransfer?.types;
  return !!types && Array.from(types).includes("Files");
}

function counted(n, one, many) {
  return `${n} ${n === 1 ? one : many}`;
}

function describe(entry) {
  const summary = entry?.summary;
  const chars = Number(summary?.chars ?? String(entry?.values?.[entry?.text_field] ?? "").length);
  const parts = [];
  if (summary) {
    parts.push(summary.mode === "REF" ? "Full-reference" : String(summary.mode || "prompt"));
    if (summary.subjects) parts.push(counted(summary.subjects, "subject", "subjects"));
    if (summary.retention) parts.push(counted(summary.retention, "retention entry", "retention entries"));
  }
  parts.push(`${chars.toLocaleString()} characters`);
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
  if (!data.ok) throw new Error(data.error || "No prompt found in that file.");
  const nodes = Array.isArray(data.nodes) ? data.nodes.filter((n) =>
    n && n.values && typeof n.values[n.text_field] === "string") : null;
  if (!nodes) throw new Error("The server part of H3 Prompt Import is older than this page. Restart ComfyUI.");
  if (!nodes.length) throw new Error("The file's prompt data is empty.");
  return { ...data, nodes };
}

function markChanged(target) {
  try { target.setDirtyCanvas?.(true, true); } catch (e) { /* Vue redraws itself */ }
  try { app.graph?.setDirtyCanvas?.(true, true); } catch (e) { /* same */ }
  try {
    app.extensionManager?.workflow?.activeWorkflow?.changeTracker?.checkState?.();
  } catch (e) { /* the tab still picks the change up on its next check */ }
}

// ---------------------------------------------------------------- choosing targets

/** Canvas nodes of the same type as a prompt node from the file, best first.
 *  `strict` keeps positive and negative apart; a person choosing by hand may cross them. */
function sameTypeCandidates(entry, importer, used, strict = true) {
  // A node inside a subgraph is saved as "<outer id>:<its own id>".
  const innerId = String(entry.id).split(":").pop();
  const out = [];
  for (const graph of allGraphs(importer)) {
    for (const n of nodesOf(graph)) {
      if (n === importer || used.has(n) || typeOf(n) !== entry.type) continue;
      if (!Object.keys(entry.values).some((k) => writable(n, widget(n, k)))) continue;
      const role = canvasRole(n, graph);
      const sameId = String(n.id) === innerId;
      // Never cross positive and negative.
      if (strict && (entry.role === "negative" ? (role !== "negative" && !sameId) : role === "negative")) continue;
      let score = 0;
      if (sameId) score += 4;
      if (entry.title && n.title === entry.title) score += 2;
      if (entry.role && role === entry.role) score += 3;
      out.push({ node: n, graph, score, role, here: graph === importer.graph });
    }
  }
  out.sort((a, b) => b.score - a.score || Number(b.here) - Number(a.here) ||
    distance(a.node, importer) - distance(b.node, importer));
  return out;
}

/** Prompt text boxes for text that has no node of its own type on the canvas.
 *  `strict` leaves out notes and never crosses positive and negative. */
function textTargets(entry, importer, used, strict = true) {
  const out = [];
  for (const graph of allGraphs(importer)) {
    for (const n of nodesOf(graph)) {
      if (n === importer || used.has(n) || ADAPTERS[typeOf(n)]?.structured) continue;
      const box = textBox(n);
      if (!box) continue;
      const words = `${typeOf(n)} ${n.title || ""}`;
      const role = canvasRole(n, graph);
      const negative = role === "negative" || /negative/i.test(words);
      const hint = NOT_A_PROMPT.test(typeOf(n)) ? -1 : /prompt/i.test(words) ? 2 : /encode/i.test(words) ? 1 : 0;
      if (strict && (hint < 0 || (entry.role === "negative") !== negative)) continue;
      out.push({ node: n, box, hint, role: negative ? "negative" : role, here: graph === importer.graph });
    }
  }
  out.sort((a, b) => b.hint - a.hint || Number(b.here) - Number(a.here) ||
    distance(a.node, importer) - distance(b.node, importer));
  return out;
}

/** The work to do: [{ node, entry, textOnly, box, note }], main target first. */
function plan(entries, importer, mode) {
  const main = entries[0];
  if (mode === MODE_SELECTED) {
    const picked = Object.values(app.canvas?.selected_nodes || {}).filter((n) => n && n !== importer);
    if (picked.length !== 1) throw new Error("Select one node on the canvas first, then drop the file again.");
    const node = picked[0];
    const entry = entries.find((e) => e.type === typeOf(node) &&
      Object.keys(e.values).some((k) => writable(node, widget(node, k))));
    if (entry) return [{ node, entry }];
    const box = ADAPTERS[typeOf(node)]?.structured ? null : textBox(node);
    if (!box) throw new Error(`The selected node, ${labelOf(node)}, has no prompt text box to write into.`);
    return [{ node, entry: main, textOnly: true, box }];
  }

  const used = new Set();
  const jobs = [];
  for (const entry of entries) {
    const found = sameTypeCandidates(entry, importer, used);
    if (!found.length) continue;
    used.add(found[0].node);
    const guessed = found.length > 1 && found[0].score === 0;
    jobs.push({ node: found[0].node, entry,
      note: guessed ? `nearest of ${found.length} ${ADAPTERS[entry.type]?.label || entry.type} nodes` : "" });
  }
  if (!jobs.some((j) => j.entry === main)) {
    const found = textTargets(main, importer, used);
    if (found.length) {
      const guessed = found.length > 1 && found[0].hint === found[1].hint;
      jobs.unshift({ node: found[0].node, entry: main, textOnly: true, box: found[0].box,
        note: `text only, no ${ADAPTERS[main.type]?.label || main.type} node here` +
          (guessed ? `, picked from ${found.length} text boxes` : "") });
    }
  }
  if (!jobs.length) {
    throw new Error("No node on this canvas can take the prompt. Add a prompt node, " +
      `or set "${TARGET_MODE}" to "${MODE_SELECTED}" and select a text node.`);
  }
  // The main prompt's target first: that is the one to open.
  jobs.sort((a, b) => Number(b.entry === main) - Number(a.entry === main));
  return jobs;
}

/** Every place on the canvas one text from the file could go, likeliest first:
 *  [{ node, label, textOnly, box }]. Offered to the person, so nothing is ruled out. */
function destinations(entry, importer) {
  const nobody = new Set();
  const tag = (role) => (role ? ` (${role})` : "");
  const full = sameTypeCandidates(entry, importer, nobody, false).map((c) => ({
    node: c.node,
    label: `${labelOf(c.node)}${tag(c.role)}${Object.keys(entry.values).length > 1 ? ", all its fields" : ""}`,
  }));
  const text = textTargets(entry, importer, nobody, false)
    .filter((t) => !full.some((f) => f.node === t.node))
    .map((t) => ({ node: t.node, textOnly: true, box: t.box, label: `${labelOf(t.node)}${tag(t.role)}, text only` }));
  return [...full, ...text];
}

function heading(entry) {
  const kind = entry.role === "negative" ? "Negative prompt" : entry.role === "positive" ? "Positive prompt" : "Prompt text";
  const from = `${ADAPTERS[entry.type]?.label || entry.title || entry.type} #${entry.id}`;
  return [kind, ` from ${from} • ${describe(entry)}`];
}

// ---------------------------------------------------------------- comparing current and new
//
// A comparison model describes what a destination holds now next to what the
// file would put there, cut into parts the person can keep or take:
//
//   rows:      [{ title, old, neu, same, exclusive, required, note }]
//              old / neu are the two texts of one part (null when a side has none).
//              exclusive: the part holds one version, so only one side can be ticked.
//              required:  one side must stay ticked.
//   compose(picks) -> what to write, for picks = [{ old: bool, neu: bool }] per row.
//   preview(out)   -> the resulting text for display, when there is one.
//   hint           -> an optional line shown above the comparison.

const sameValue = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const copyOf = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
const pretty = (label) => label.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());

/** The picks that take everything from one side ("old" or "neu"). */
function allFrom(model, side) {
  const other = side === "old" ? "neu" : "old";
  return model.rows.map((r) => {
    if (r.same) return { old: true, neu: true };
    const p = { old: false, neu: false };
    if (r[side] != null) p[side] = true;
    else if (r.required && r[other] != null) p[other] = true;
    return p;
  });
}

/** Blocks of a text separated by blank lines: [{ label, text }]. A block that
 *  opens with "some_label:" carries that label, lower-cased. */
function splitSections(text) {
  return String(text ?? "").replace(/\r\n/g, "\n").split(/\n(?:[ \t]*\n)+/)
    .map((t) => t.trim()).filter(Boolean).map((t) => {
      const m = t.match(/^([A-Za-z][\w \-]{1,40}):(?=\s|$)/);
      return { label: m ? m[1].trim().toLowerCase() : null, text: t };
    });
}

/** Line the parts of two texts up: by label where both have it, else in order.
 *  Rows follow the new text; parts only the old text has keep their place.
 *  [{ label, old, neu }] with null for a side that has no such part. */
function alignSections(oldText, newText) {
  const olds = splitSections(oldText);
  const news = splitSections(newText);
  const partner = new Map();          // index in news -> index in olds
  const taken = new Set();
  news.forEach((n, i) => {
    if (!n.label) return;
    const j = olds.findIndex((o, k) => !taken.has(k) && o.label === n.label);
    if (j >= 0) { partner.set(i, j); taken.add(j); }
  });
  // The rest pair up in order. Once labels have matched, the texts are labelled
  // sections, and a labelled part is not paired with an unrelated paragraph.
  const labelled = partner.size > 0;
  const free = olds.map((_, k) => k).filter((k) => !taken.has(k) && !(labelled && olds[k].label));
  news.forEach((n, i) => {
    if (partner.has(i) || !free.length || (labelled && n.label)) return;
    const j = free.shift();
    partner.set(i, j);
    taken.add(j);
  });
  const rows = news.map((n, i) => {
    const j = partner.has(i) ? partner.get(i) : -1;
    return { label: n.label, neu: n.text, old: j < 0 ? null : olds[j].text, oldIndex: j };
  });
  olds.forEach((o, k) => {
    if (taken.has(k)) return;
    let at = 0;
    for (let p = k - 1; p >= 0; p--) {
      const r = rows.findIndex((row) => row.oldIndex === p);
      if (r >= 0) { at = r + 1; break; }
    }
    rows.splice(at, 0, { label: o.label, neu: null, old: o.text, oldIndex: k });
  });
  return rows;
}

/** Plain text against plain text. Any mix of parts from either side may be
 *  kept; a part ticked on both sides is kept twice, current first.
 *  Null when the destination is empty, since there is nothing to compare. */
function textModel(oldText, newText) {
  oldText = String(oldText ?? "");
  newText = String(newText ?? "");
  if (!oldText.trim()) return null;
  const aligned = alignSections(oldText, newText);
  const rows = aligned.map((r, i) => ({
    title: r.label ? pretty(r.label) : aligned.length === 1 ? "Whole text" : `Part ${i + 1}`,
    old: r.old, neu: r.neu, same: r.old === r.neu,
  }));
  return {
    rows,
    compose(picks) {
      const on = (i, side) => !!picks[i]?.[side];
      // Untouched choices give the text back exactly, spacing included.
      const onlyNew = rows.every((r, i) => (r.same ? on(i, "neu") : !on(i, "old") && (r.neu == null || on(i, "neu"))));
      const onlyOld = rows.every((r, i) => (r.same ? on(i, "neu") : !on(i, "neu") && (r.old == null || on(i, "old"))));
      if (onlyNew) return newText;
      if (onlyOld) return oldText;
      const parts = [];
      rows.forEach((r, i) => {
        if (r.same) { if (on(i, "neu")) parts.push(r.neu); return; }
        if (on(i, "old") && r.old != null) parts.push(r.old);
        if (on(i, "neu") && r.neu != null) parts.push(r.neu);
      });
      return parts.join("\n\n");
    },
    preview: (out) => out,
  };
}

/** A prompt tool's settings against the file's, one row per widget. */
function fieldsModel(node, values) {
  const rows = [];
  for (const [name, value] of Object.entries(values)) {
    const w = widget(node, name);
    if (!writable(node, w)) continue;
    const fits = fitsWidget(w, value);
    rows.push({ key: name, title: name, raw: value, old: String(w.value ?? ""), neu: fits ? String(value) : null,
      same: w.value === value, exclusive: true, required: true,
      note: fits ? "" : "The file's value is not available here." });
  }
  if (!rows.length || rows.every((r) => !r.old.trim())) return null;
  return {
    rows,
    // Only the values that change.
    compose(picks) {
      const out = {};
      rows.forEach((r, i) => { if (!r.same && r.neu != null && picks[i]?.neu) out[r.key] = r.raw; });
      return out;
    },
  };
}

// The Fantastic Prompt Builder writes its prompt as labelled sections, each
// made from its own part of the saved state. So a section can be swapped by
// taking both its text block and its state from the same side.
const BUILDER_SETUP = ["mode", "duration", "p2Shot", "lastShot"];
const BUILDER_PARTS = {
  REF: [   // [section label, title, optional, state paths]
    ["subject_definitions", "Subject definitions", true, [["ref", "subjectDefs"]]],
    ["summary", "Summary", false, [["ref", "summaryTypes"], ["ref", "summaryText"]]],
    ["retention_analysis", "Retention analysis", true, [["ref", "retention"]]],
    ["detailed_description", "Style and description", false, [["ref", "styleLine"], ["ref", "detail"]]],
    ["overall_soundscape", "Soundscape", true, [["ref", "soundscape"]]],
    ["non_diegetic_music", "Music", true, [["ref", "music"]]],
  ],
  BASE: [
    ["integrated_multimodal_description", "Description", false, [["imd"]]],
    ["overall_soundscape", "Soundscape", true, [["soundscape"]]],
    ["non_diegetic_music", "Music", true, [["music"]]],
  ],
};
const BUILDER_LABELS = [...new Set(Object.values(BUILDER_PARTS).flat().map((p) => p[0]))];

/** { head, blocks: { label: "label: text" } } of a builder-made prompt. */
function builderBlocks(text) {
  const blocks = {};
  const head = [];
  let current = null;
  for (const line of String(text ?? "").replace(/\r\n/g, "\n").split("\n")) {
    const m = line.match(/^([a-z_]+):/);
    if (m && BUILDER_LABELS.includes(m[1])) { current = m[1]; blocks[current] = [line]; }
    else if (current) blocks[current].push(line);
    else head.push(line);
  }
  for (const k of Object.keys(blocks)) blocks[k] = blocks[k].join("\n").trim();
  return { head: head.join("\n").trim(), blocks };
}

/** The builder's current fields against the file's, one row per section.
 *  Null when either side holds no builder state, so there is nothing to mix. */
function builderModel(oldVals, newVals) {
  const parse = (v) => {
    try { const s = JSON.parse(v?.builder_state || "{}"); return s && s.version ? s : null; } catch (e) { return null; }
  };
  const oldState = parse(oldVals);
  const newState = parse(newVals);
  if (!oldState || !newState) return null;
  const family = (s) => (s.mode === "REF" ? "REF" : "BASE");
  const oldText = String(oldVals.prompt_text ?? "");
  const newText = String(newVals.prompt_text ?? "");
  const whole = (picked) => ({ prompt_text: picked.prompt_text, builder_state: picked.builder_state });
  const preview = (out) => out.prompt_text;

  if (family(oldState) !== family(newState)) {
    return {
      hint: "The current prompt and the file use different modes, so they cannot be mixed section by section.",
      rows: [{ title: "Whole prompt", old: oldText, neu: newText, same: oldText === newText, exclusive: true, required: true }],
      compose: (picks) => whole(picks[0]?.neu ? newVals : oldVals),
      preview,
    };
  }

  const read = (state, path) => path.reduce((o, k) => (o == null ? undefined : o[k]), state);
  const write = (state, path, value) => {
    let o = state;
    path.slice(0, -1).forEach((k) => { o = o[k] = o[k] && typeof o[k] === "object" ? o[k] : {}; });
    o[path.at(-1)] = value;
  };
  const body = (block) => (block == null ? null : block.replace(/^[a-z_]+:\s*/, ""));
  const a = builderBlocks(oldText);
  const b = builderBlocks(newText);
  const rows = [];
  if (family(oldState) === "BASE" && (a.head !== b.head || !BUILDER_SETUP.every((k) => sameValue(oldState[k], newState[k])))) {
    const setup = (s, head) => `${s.mode}, ${s.duration} seconds` + (head ? `\n${head}` : "");
    rows.push({ key: "__setup", title: "Mode and timing", old: setup(oldState, a.head), neu: setup(newState, b.head),
      same: false, exclusive: true, required: true });
  }
  for (const [key, title, optional, paths] of BUILDER_PARTS[family(oldState)]) {
    const oldBlock = a.blocks[key] ?? null;
    const neuBlock = b.blocks[key] ?? null;
    if (oldBlock == null && neuBlock == null) continue;      // off on both sides: nothing to choose
    const sameState = paths.every((p) => sameValue(read(oldState, p), read(newState, p)));
    rows.push({ key, title, paths, oldBlock, neuBlock, old: body(oldBlock), neu: body(neuBlock),
      same: oldBlock === neuBlock && sameState, exclusive: true, required: !optional,
      note: optional ? "Untick both sides to leave this section out of the prompt." : "" });
  }

  const choose = (picks) => rows.map((r, i) => (r.same ? "old"
    : picks[i]?.neu && r.neu != null ? "new"
      : picks[i]?.old && r.old != null ? "old"
        : r.required ? (r.old != null ? "old" : "new") : "off"));
  // Section text may refer to a subject by name, and the builder turns that
  // into the subject's tag using the subject definitions. A mix that takes the
  // definitions from one side and such text from the other can leave them apart.
  const naming = (s) => JSON.stringify((s.ref?.subjectDefs || []).filter((d) => !d.off).map((d) =>
    [(String(d.text || "").match(/^\s*<Subject (\d+)>/) || [])[1] || "", String(d.name || "").trim().toLowerCase()]));
  const namesDiffer = family(oldState) === "REF" && naming(oldState) !== naming(newState);

  return {
    rows,
    warn(picks) {
      const subjects = rows.findIndex((r) => r.key === "subject_definitions");
      if (!namesDiffer || subjects < 0 || rows[subjects].same) return "";
      const choice = choose(picks);
      const mixed = choice[subjects] !== "off" &&
        rows.some((r, i) => i !== subjects && !r.same && choice[i] !== "off" && choice[i] !== choice[subjects]);
      return mixed ? "The subject definitions come from one side and other sections from the other, and the two sides " +
        "name their subjects differently. Names in the text may not match the subjects. Check them in the editor afterwards." : "";
    },
    compose(picks) {
      const choice = choose(picks);
      // Untouched choices give back exactly what one side holds.
      if (rows.every((r, i) => r.same || choice[i] === "new" || (choice[i] === "off" && r.neu == null))) return whole(newVals);
      if (rows.every((r, i) => r.same || choice[i] === "old" || (choice[i] === "off" && r.old == null))) return whole(oldVals);
      const state = copyOf(oldState);
      state.off = { ...(state.off || {}) };
      let head = a.head;
      const blocks = [];
      rows.forEach((r, i) => {
        const c = choice[i];
        if (r.key === "__setup") {
          if (c === "new") {
            for (const k of BUILDER_SETUP) if (k in newState) state[k] = copyOf(newState[k]);
            head = b.head;
          }
          return;
        }
        if (c === "new") for (const p of r.paths) write(state, p, copyOf(read(newState, p)));
        if (c === "off") state.off[r.key] = true; else delete state.off[r.key];
        const block = c === "new" ? r.neuBlock : c === "old" ? r.oldBlock : null;
        if (block) blocks.push(block);
      });
      return { prompt_text: [head, ...blocks].filter(Boolean).join("\n\n"), builder_state: JSON.stringify(state) };
    },
    preview,
  };
}

/** The comparison for sending one text from the file to one destination, or
 *  null when the destination holds nothing to compare with. */
function compareModel(option, entry) {
  const node = option.node;
  const incoming = entry.values[entry.text_field];
  if (option.textOnly) return textModel(option.box.value, incoming);
  const adapter = ADAPTERS[typeOf(node)];
  if (adapter?.compare) {
    const current = Object.fromEntries(Object.keys(entry.values).map((k) => [k, widget(node, k)?.value]));
    return adapter.compare(current, entry.values);
  }
  const names = Object.keys(entry.values);
  if (names.length === 1 && typeof incoming === "string") {
    const w = widget(node, names[0]);
    const model = writable(node, w) ? textModel(w.value, incoming) : null;
    return model && { ...model, compose: (picks) => ({ [names[0]]: model.compose(picks) }), preview: (out) => out[names[0]] };
  }
  return fieldsModel(node, entry.values);
}

// ---------------------------------------------------------------- the chooser

/** A dialog listing each prompt text found in the file. Each has a "copy to"
 *  list, and once a destination is chosen, a side by side view of what that
 *  destination holds now and what the file brings, part by part, with a tick
 *  box on each side. `result` resolves to the chosen jobs, or null when cancelled. */
class Chooser {
  constructor(importer, fileName, entries, suggested) {
    this.rows = [];
    this.result = new Promise((resolve) => { this.resolve = resolve; });

    const list = make("div", "h3pi-rows");
    for (const entry of entries) {
      const options = destinations(entry, importer);
      const select = make("select");
      const none = make("option", "", options.length ? "Do not copy" : "Do not copy (no node on this canvas can take it)");
      none.value = "";
      select.append(none);
      options.forEach((o, i) => {
        const option = make("option", "", o.label);
        option.value = String(i);
        select.append(option);
      });
      const hint = suggested.find((j) => j.entry === entry);
      const chosen = hint ? options.findIndex((o) => o.node === hint.node && !!o.textOnly === !!hint.textOnly) : -1;
      select.value = chosen < 0 ? "" : String(chosen);
      select.disabled = !options.length;

      const row = { entry, options, select, model: null, picks: [], boxes: [], el: make("div", "h3pi-row"), panel: make("div", "h3pi-panel") };
      const [kind, from] = heading(entry);
      const head = make("div", "h3pi-row-head", kind);
      head.append(make("span", "h3pi-from", from));
      const dest = make("label", "h3pi-dest");
      dest.append(make("span", "", "Copy to"), select);
      row.el.append(head, dest, row.panel);
      select.addEventListener("change", () => { this.problem.textContent = ""; this.render(row); });
      this.rows.push(row);
      this.render(row);
      list.append(row.el);
    }

    this.problem = make("span", "h3pi-problem");
    const cancel = make("button", "", "Cancel");
    cancel.addEventListener("click", () => this.cancel());
    const go = make("button", "h3pi-go", "Copy");
    go.addEventListener("click", () => this.apply());
    const foot = make("div", "h3pi-foot");
    foot.append(this.problem, cancel, go);

    const dialog = make("div", "h3pi-dialog");
    dialog.tabIndex = -1;
    dialog.append(
      make("h3", "", `Copy prompt text from ${fileName}`),
      make("p", "h3pi-hint", counted(entries.length, "prompt text was", "prompt texts were") +
        " found in this file. Choose where each one goes, or leave it out. Where the destination already holds text," +
        " tick what to keep from each side. Nothing is copied until you press Copy."),
      list, foot);
    this.overlay = make("div", "h3pi-overlay");
    this.overlay.append(dialog);
    // Keep the canvas underneath from reacting while the dialog is open.
    for (const type of ["pointerdown", "mousedown", "wheel", "contextmenu", "dragover", "drop",
      "keydown", "keyup", "copy", "cut", "paste"]) {
      this.overlay.addEventListener(type, (e) => {
        e.stopPropagation?.();
        if (type === "dragover" || type === "drop") e.preventDefault?.();
        if (type === "keydown" && e.key === "Escape") this.cancel();
      });
    }
    // The canvas listens for keys before anything else does (Delete removes the
    // selected nodes), so keys are also stopped at the very top while this is open.
    this.onKey = (e) => {
      e.stopPropagation();
      if (e.key === "Escape") this.cancel();
    };
    globalThis.addEventListener?.("keydown", this.onKey, true);
    document.body.append(this.overlay);
    dialog.focus?.();
  }

  /** Draw one text's panel for its chosen destination. */
  render(row) {
    const option = row.select.value === "" ? null : row.options[Number(row.select.value)];
    const incoming = row.entry.values[row.entry.text_field];
    row.model = option ? compareModel(option, row.entry) : null;
    row.picks = row.model ? allFrom(row.model, "neu") : [];
    row.boxes = [];
    row.resultTitle = row.resultText = null;
    if (!option) {
      row.el.classList.add("off");
      row.panel.replaceChildren(make("pre", "h3pi-text", incoming));
      return;
    }
    row.el.classList.remove("off");
    if (!row.model) {
      row.panel.replaceChildren(
        make("div", "h3pi-hint", `${labelOf(option.node)} holds nothing to compare with, so the text from the file is copied as it is.`),
        make("pre", "h3pi-text", incoming));
      return;
    }

    const parts = [];
    if (row.model.hint) parts.push(make("div", "h3pi-hint", row.model.hint));
    const quick = make("div", "h3pi-quick");
    const keepAll = make("button", "", "Keep everything current");
    keepAll.addEventListener("click", () => this.setAll(row, "old"));
    const takeAll = make("button", "", "Take everything from the file");
    takeAll.addEventListener("click", () => this.setAll(row, "neu"));
    quick.append(keepAll, takeAll);
    const titles = make("div", "h3pi-pair");
    titles.append(make("div", "h3pi-col-title", `Current in ${labelOf(option.node)}`), make("div", "h3pi-col-title", "From the file"));
    parts.push(quick, titles);

    row.model.rows.forEach((r, i) => {
      const section = make("div", "h3pi-sec");
      const title = make("div", "h3pi-sec-title", r.title);
      if (r.same) title.append(make("span", "h3pi-from", " Same on both sides."));
      else if (r.note) title.append(make("span", "h3pi-from", ` ${r.note}`));
      section.append(title);
      const side = (name, text) => {
        const wrap = make("label", "h3pi-side");
        const tick = make("input");
        tick.type = "checkbox";
        tick.disabled = text == null;
        tick.addEventListener("change", () => this.toggle(row, i, name, tick.checked));
        wrap.append(tick, make("pre", "h3pi-text", text == null ? "(nothing here)" : text || "(empty)"));
        return { wrap, tick };
      };
      if (r.same && r.exclusive) {
        section.append(make("pre", "h3pi-text h3pi-dim", r.neu || "(empty)"));
        row.boxes.push({});
      } else if (r.same) {
        const one = side("neu", r.neu);
        section.append(one.wrap);
        row.boxes.push({ neu: one.tick, neuWrap: one.wrap });
      } else {
        const pair = make("div", "h3pi-pair");
        const left = side("old", r.old);
        const right = side("neu", r.neu);
        pair.append(left.wrap, right.wrap);
        section.append(pair);
        row.boxes.push({ old: left.tick, oldWrap: left.wrap, neu: right.tick, neuWrap: right.wrap });
      }
      parts.push(section);
    });

    row.warning = make("div", "h3pi-warning");
    parts.push(row.warning);
    if (row.model.preview) {
      const result = make("details", "h3pi-result");
      row.resultTitle = make("summary", "", "Result");
      row.resultText = make("pre", "h3pi-text");
      result.append(row.resultTitle, row.resultText);
      parts.push(result);
    }
    row.panel.replaceChildren(...parts);
    this.sync(row);
  }

  /** One tick box changed. */
  toggle(row, i, side, checked) {
    const r = row.model.rows[i];
    const p = row.picks[i];
    const other = side === "old" ? "neu" : "old";
    if (r.same) {
      p.old = p.neu = checked;
    } else {
      p[side] = checked;
      if (checked && r.exclusive) p[other] = false;
      // A part that must be there falls back to the other side, or stays.
      if (!checked && r.required && !p[other]) p[r[other] != null ? other : side] = true;
    }
    this.problem.textContent = "";
    this.sync(row);
  }

  setAll(row, side) {
    row.picks = allFrom(row.model, side);
    this.problem.textContent = "";
    this.sync(row);
  }

  /** Make the tick boxes and the result preview show the current picks. */
  sync(row) {
    row.model.rows.forEach((r, i) => {
      for (const side of ["old", "neu"]) {
        const tick = row.boxes[i][side];
        if (!tick) continue;
        tick.checked = !!row.picks[i][side];
        const wrap = row.boxes[i][`${side}Wrap`];
        if (tick.checked) wrap.classList.add("picked"); else wrap.classList.remove("picked");
      }
    });
    row.warning.textContent = row.model.warn?.(row.picks) || "";
    if (row.resultText) {
      const text = String(row.model.preview(row.model.compose(row.picks)) ?? "");
      row.resultTitle.textContent = `Result: ${text.length.toLocaleString()} characters. Click to see it.`;
      row.resultText.textContent = text;
    }
  }

  /** The chosen work, the file's main text first. */
  jobs() {
    return this.rows.filter((r) => r.select.value !== "").map((r) => {
      const o = r.options[Number(r.select.value)];
      const job = { node: o.node, entry: r.entry, textOnly: o.textOnly, box: o.box };
      if (r.model) {
        const out = r.model.compose(r.picks);
        if (o.textOnly) job.text = out; else job.values = out;
      }
      return job;
    });
  }

  apply() {
    const jobs = this.jobs();
    if (!jobs.length) {
      this.problem.textContent = "Nothing is chosen. Pick a place for at least one text, or press Cancel.";
      return;
    }
    const twice = jobs.find((j, i) => jobs.findIndex((k) => k.node === j.node) !== i);
    if (twice) {
      this.problem.textContent = `Two texts point at ${labelOf(twice.node)}. Send each one somewhere different.`;
      return;
    }
    this.close(jobs);
  }

  cancel() {
    this.close(null);
  }

  close(jobs) {
    globalThis.removeEventListener?.("keydown", this.onKey, true);
    this.overlay.remove?.();
    this.resolve(jobs);
  }
}

// ---------------------------------------------------------------- the node

class Importer {
  constructor(node) {
    this.node = node;
    this.previous = null;   // [{ node, w, before }] for Undo
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

    this.status("", IDLE, IDLE_SUB);
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
    this.busy = true;
    this.status("", `Reading ${file.name}…`);
    try {
      const data = await readFile(file);
      const picked = widget(this.node, TARGET_MODE)?.value;
      const mode = picked === MODE_SELECTED || picked === MODE_AUTO ? picked : MODE_ASK;
      const jobs = mode === MODE_ASK ? await this.ask(file.name, data.nodes) : plan(data.nodes, this.node, mode);
      if (!jobs) {
        this.status("", "Cancelled. Nothing copied.", IDLE);
        return;
      }
      const skipped = this.apply(jobs);
      if (!this.previous.length && !skipped) {
        this.status("", "Nothing changed.", "What was chosen is what the canvas already holds.");
        return;
      }
      const notes = [describe(jobs[0].entry), ...jobs.map((j) => j.note)];
      if (skipped) notes.push(`${counted(skipped, "value was", "values were")} not available here and kept as set`);
      const left = data.nodes.length - new Set(jobs.map((j) => j.entry)).size;
      if (left > 0 && mode === MODE_AUTO) notes.push(`${counted(left, "other prompt node", "other prompt nodes")} in the file had no match`);
      if (left > 0 && mode === MODE_ASK) notes.push(`${jobs.length} of ${data.nodes.length} texts copied`);
      if (files.length > 1) notes.push("only the first file was read");
      const where = jobs.length === 1 ? labelOf(jobs[0].node)
        : `${jobs.length} nodes: ${jobs.map((j) => labelOf(j.node)).join(", ")}`;
      this.status("ok", `Copied ${file.name} into ${where}.`, notes.filter(Boolean).join(" • "));
    } catch (err) {
      console.error("[H3 Prompt Import]", err);
      this.status("err", "Nothing copied.", String(err?.message || err));
    } finally {
      this.busy = false;
    }
  }

  /** Let the person choose which texts to keep and where each goes. The
   *  automatic match is only the starting selection. Null when cancelled. */
  async ask(fileName, entries) {
    let suggested = [];
    try { suggested = plan(entries, this.node, MODE_AUTO); } catch (e) { /* nothing to suggest */ }
    this.status("", `Choose where the text from ${fileName} goes.`, "Waiting for your choice in the dialog.");
    this.chooser = new Chooser(this.node, fileName, entries, suggested);
    if (!this.chooser.rows.some((r) => r.options.length)) {
      this.chooser.cancel();
      this.chooser = null;
      throw new Error("No node on this canvas can take the prompt. Add a prompt node or a text node first.");
    }
    try { return await this.chooser.result; } finally { this.chooser = null; }
  }

  /** Write the planned values. Returns how many values could not be set. */
  apply(jobs) {
    const changes = [];
    let skipped = 0;
    for (const job of jobs) {
      // The chooser hands over what the person mixed; otherwise it is the file's values as they are.
      const pairs = job.textOnly
        ? [[job.box, job.text ?? job.entry.values[job.entry.text_field]]]
        : Object.entries(job.values ?? job.entry.values).map(([name, value]) => [widget(job.node, name), value]);
      for (const [w, value] of pairs) {
        if (!writable(job.node, w) || w.value === value) continue;
        if (!fitsWidget(w, value)) { skipped++; continue; }
        changes.push({ node: job.node, w, before: w.value });
        this.write(job.node, w, value);
      }
    }
    this.previous = changes;
    const open = !!widget(this.node, OPEN_TOGGLE)?.value;
    jobs.forEach((job, i) => {
      markChanged(job.node);
      this.show(job.node, open && i === 0);
    });
    return skipped;
  }

  write(node, w, value) {
    w.value = value;
    if (ADAPTERS[typeOf(node)]?.quiet) return;
    try { w.callback?.(value, app.canvas, node); } catch (err) {
      console.warn("[H3 Prompt Import] a widget's change handler failed:", err);
    }
  }

  /** Make a node show what it now holds. With `open`, bring its editor up:
   *  the tool's own editor if it has one, else the node and its text box. */
  show(node, open) {
    const adapter = ADAPTERS[typeOf(node)];
    try {
      if (!open) { adapter?.refresh?.(node); return; }
      if (adapter?.open?.(node)) return;
      const button = (node.widgets || []).find((w) => w.type === "button" && w.callback &&
        /^(edit|open)\b.*\b(prompt|editor|builder)/i.test(String(w.name)));
      if (button) { button.callback(); return; }
      adapter?.refresh?.(node);
      this.reveal(node);
    } catch (err) {
      console.warn("[H3 Prompt Import] values copied; the node did not redraw:", err);
    }
  }

  /** Select the node, bring it on screen if it is not, and focus its text box. */
  reveal(node) {
    const canvas = app.canvas;
    if (!canvas || (canvas.graph && node.graph && canvas.graph !== node.graph)) return;
    canvas.selectNode?.(node, false);
    const area = canvas.visible_area || canvas.ds?.visible_area;
    const [x, y] = node.pos || [0, 0];
    const [w, h] = node.size || [0, 0];
    const onScreen = !area || (x < area[0] + area[2] && x + w > area[0] && y < area[1] + area[3] && y + h > area[1]);
    if (!onScreen) canvas.centerOnNode?.(node);
    const box = textBox(node);
    (box?.inputEl || box?.element)?.focus?.();
  }

  undo() {
    const changes = this.previous;
    if (!changes?.length) {
      this.status("", "Nothing to undo.", IDLE);
      return;
    }
    const alive = new Set(allGraphs(this.node).flatMap((g) => nodesOf(g)));
    const nodes = [...new Set(changes.map((c) => c.node))];
    const gone = nodes.filter((n) => !alive.has(n));
    if (gone.length === nodes.length) {
      this.status("err", "Undo failed.", `${labelOf(gone[0])} is no longer in the graph.`);
      return;
    }
    for (const c of [...changes].reverse()) {
      if (alive.has(c.node)) this.write(c.node, c.w, c.before);
    }
    this.previous = null;
    const restored = nodes.filter((n) => alive.has(n));
    for (const n of restored) { markChanged(n); this.show(n, false); }
    this.status("", `Restored ${restored.map(labelOf).join(", ")} to what ${restored.length === 1 ? "it" : "they"} held before.`, IDLE);
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
        // Added last so nodes saved before this option existed load unchanged.
        this.addWidget("combo", TARGET_MODE, MODE_ASK, () => {}, { values: [MODE_ASK, MODE_AUTO, MODE_SELECTED] });
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

// For the tests. ComfyUI loads this file for what it registers and ignores these.
export const __test = { splitSections, alignSections, textModel, fieldsModel, builderBlocks, builderModel };
