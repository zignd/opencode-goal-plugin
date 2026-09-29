// The discovered TUI entrypoint. OpenCode looks for `tui.ts` beside `index.ts`,
// but the panel is JSX and JSX needs the .tsx extension to compile, so this
// re-exports the real thing from src/.
export { default } from "./src/tui.js"
