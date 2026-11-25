// Stand-in for ComfyUI's scripts/app.js, used only by run.mjs.
export const app = {
  extensions: [],
  registerExtension(ext) { this.extensions.push(ext); },
  graph: null,
};
