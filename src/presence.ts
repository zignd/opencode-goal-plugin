/**
 * Whether a TUI is showing this project. The TUI reports the directory it was started in, and a
 * session can live in a subdirectory, behind a symlink, or have been moved. Comparing the two raw
 * strings missed those, and a miss turns `/goal help` into a transcript message, which is a prompt.
 */

export const trimDir = (path: string): string => path.replace(/\/+$/, "") || "/"

/** The same place, or one inside the other. A path boundary, so /a/b does not match /a/bc. */
export function samePlace(a: string, b: string): boolean {
  const left = trimDir(a)
  const right = trimDir(b)
  if (left === right) return true
  const under = (child: string, parent: string) => parent === "/" || child.startsWith(`${parent}/`)
  return under(left, right) || under(right, left)
}

export type PresenceRecord = { at?: unknown; directory?: unknown }

export function presentFor(
  records: readonly PresenceRecord[],
  directory: string,
  now: number,
  ttlMs: number,
  canonical: (path: string) => string = (path) => path,
): boolean {
  const wanted = [directory, canonical(directory)]
  return records.some((record) => {
    if (typeof record.at !== "number" || now - record.at > ttlMs) return false
    if (typeof record.directory !== "string") return false
    const seen = [record.directory, canonical(record.directory)]
    return wanted.some((one) => seen.some((other) => samePlace(one, other)))
  })
}
