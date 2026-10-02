/** Head and tail, with the omitted middle counted. A tail-only slice drops the proof. */

export const OUTPUT_CAP = 4000

export function capText(text: string, cap = OUTPUT_CAP): string {
  if (text.length <= cap) return text
  const head = Math.floor(cap / 2)
  const tail = cap - head
  const omitted = text.length - head - tail
  const marked = `${text.slice(0, head)}\n… (${omitted} characters omitted) …\n${text.slice(-tail)}`
  // A text only just over the cap can be shorter than the omission notice. Keep it whole.
  return marked.length < text.length ? marked : text
}
