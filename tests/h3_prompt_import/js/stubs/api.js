// Stand-in for ComfyUI's scripts/api.js, used only by run.mjs.
export const api = {
  calls: [],
  next: null,
  async fetchApi(url, opts) { this.calls.push({ url, opts }); return this.next(url, opts); },
};
