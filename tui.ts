// Auto-discovery looks for `tui.ts` next to `index.ts`, but JSX needs the .tsx
// extension to compile. This re-export is the discovered entrypoint; the panel
// itself lives in tui.tsx.
export { default } from "./tui.tsx"
