/**
 * The plugin imports `./file.js` so OpenCode's loader can find the TypeScript.
 * `node --test` loads the `.ts` files directly and does not rewrite that specifier.
 */
export async function resolve(specifier, context, nextResolve) {
  const parent = context.parentURL ?? ""
  const local = specifier.startsWith("./") || specifier.startsWith("../")
  const ours = parent.includes("/src/") || parent.includes("/test/")
  if (local && ours && specifier.endsWith(".js")) {
    try {
      return await nextResolve(specifier.slice(0, -3) + ".ts", context)
    } catch {
      return nextResolve(specifier, context)
    }
  }
  return nextResolve(specifier, context)
}
