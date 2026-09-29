// OpenCode discovers a plugin by looking for `index.ts` and `tui.ts` in the
// plugin directory, so both have to stay at the root. They are entrypoints
// only; everything they serve lives in src/.
export { default } from "./src/server.js"
