import { createSignal, For, Show } from "solid-js"
import {
  collapseAll,
  expandAll,
  formatDuration,
  glyph,
  initialOpen,
  toggleOpen,
  totalMs,
  type Round,
  type RoundOutcome,
  type Section,
} from "./rounds.js"
import type { SettingControl, SettingsForm } from "./settings.js"

/**
 * The scrolling, sectioned views. Layout only: what to show comes from rounds.ts and help.ts,
 * which are tested without the host. These components were checked by the type system and by
 * the tests of what they are given, not by looking at a terminal.
 *
 * Scrolling is the scrollbox's own mouse wheel. A plugin dialog receives no plugin key
 * bindings in this host, so nothing here depends on one; the controls are clickable.
 */

export type Palette = { base: string; muted: string; success: string; warning: string; error: string }

export const outcomeColour = (palette: Palette, outcome: RoundOutcome): string =>
  outcome === "done" ? palette.success : outcome === "blocked" ? palette.error : outcome === "continue" ? palette.base : palette.warning

export const Divider = (props: { palette: Palette; width?: number }) => (
  <text fg={props.palette.muted}>{"─".repeat(Math.max(8, props.width ?? 40))}</text>
)

export const Heading = (props: { palette: Palette; text: string }) => (
  <text fg={props.palette.muted}>{props.text.toUpperCase()}</text>
)

const Frame = (props: {
  palette: Palette
  title: string
  subtitle?: string
  onClose: () => void
  actions?: { label: string; run: () => void }[]
  children: any
}) => (
  <box flexDirection="column" paddingLeft={2} paddingRight={2} paddingTop={1} paddingBottom={1}>
    <box flexDirection="row" justifyContent="space-between">
      <text fg={props.palette.base}>{props.title}</text>
      <text fg={props.palette.muted} onMouseDown={() => props.onClose()}>
        [close]
      </text>
    </box>
    <Show when={props.subtitle}>
      <text fg={props.palette.muted}>{props.subtitle}</text>
    </Show>
    <Show when={props.actions?.length}>
      <box flexDirection="row" gap={2}>
        <For each={props.actions}>
          {(action) => (
            <text fg={props.palette.warning} onMouseDown={() => action.run()}>
              [{action.label}]
            </text>
          )}
        </For>
      </box>
    </Show>
    <Divider palette={props.palette} />
    {props.children}
  </box>
)

/**
 * `/goal settings`, as controls rather than a printout. A click sends the same argument the
 * slash command would. Free text goes through `onEdit`, which the host prompt handles,
 * because this dialog receives no keys.
 */
export const SettingsView = (props: {
  palette: Palette
  form: () => SettingsForm
  error: () => string
  maxHeight: number
  onClose: () => void
  onChoose: (key: SettingControl["key"], argument: string) => void
  onEdit: (control: SettingControl) => void
}) => (
  <Frame palette={props.palette} title="/goal settings" subtitle={props.form().intro} onClose={props.onClose}>
    <scrollbox maxHeight={props.maxHeight} focused>
      <Show when={props.error()}>
        <text fg={props.palette.error}>{props.error()}</text>
      </Show>
      <For each={props.form().controls}>
        {(control, index) => (
          <box flexDirection="column" paddingBottom={1}>
            <Show when={index() > 0}>
              <Divider palette={props.palette} />
            </Show>
            <box flexDirection="row" justifyContent="space-between">
              <text fg={props.palette.warning}>{control.label}</text>
              <text fg={props.palette.muted}>{control.source}</text>
            </box>
            <text
              fg={props.palette.base}
              onMouseDown={() => {
                if (control.key === "quiet") props.onChoose("quiet", control.value === "on" ? "off" : "on")
                else if (control.editable) props.onEdit(control)
              }}
            >
              {control.value}
            </text>
            <text fg={props.palette.muted}>{control.hint}</text>
            <box flexDirection="row" gap={1} flexWrap="wrap">
              <For each={control.choices}>
                {(item) => (
                  <text
                    fg={item.current ? props.palette.success : props.palette.warning}
                    onMouseDown={() => {
                      if (!item.current) props.onChoose(control.key, item.argument)
                    }}
                  >
                    [{item.label}]
                  </text>
                )}
              </For>
              <Show when={control.editable}>
                <text fg={props.palette.warning} onMouseDown={() => props.onEdit(control)}>
                  [type…]
                </text>
              </Show>
            </box>
          </box>
        )}
      </For>
      <Divider palette={props.palette} />
      <text fg={props.palette.warning}>Commands</text>
      <text fg={props.palette.muted}>The same changes, typed:</text>
      <For each={props.form().commands}>{(line) => <text fg={props.palette.base}>{line}</text>}</For>
      <Divider palette={props.palette} />
      <text fg={props.palette.warning}>Notes</text>
      <For each={props.form().notes}>{(line) => <text fg={props.palette.muted}>{line}</text>}</For>
    </scrollbox>
  </Frame>
)

/** Titled blocks with a divider between them. Used for help and settings. */
export const SectionedView = (props: {
  palette: Palette
  title: string
  sections: Section[]
  maxHeight: number
  onClose: () => void
}) => (
  <Frame palette={props.palette} title={props.title} onClose={props.onClose}>
    <scrollbox maxHeight={props.maxHeight} focused>
      <For each={props.sections}>
        {(section, index) => (
          <box flexDirection="column">
            <Show when={index() > 0}>
              <Divider palette={props.palette} />
            </Show>
            <text fg={props.palette.warning}>{section.title}</text>
            <For each={section.lines}>{(line) => <text fg={props.palette.base}>{line}</text>}</For>
          </box>
        )}
      </For>
    </scrollbox>
  </Frame>
)

/** Every round, newest first, each a header that expands to what it achieved. */
export const RoundsView = (props: {
  palette: Palette
  rounds: () => Round[]
  dropped: () => number
  maxHeight: number
  onClose: () => void
}) => {
  const [open, setOpen] = createSignal(initialOpen(props.rounds()))
  const newestFirst = () => [...props.rounds()].reverse()
  const subtitle = () => {
    const rounds = props.rounds()
    if (rounds.length === 0) return "No rounds recorded yet."
    const kept = props.dropped() > 0 ? ` (${props.dropped()} earlier not kept)` : ""
    return `${rounds.length} ${rounds.length === 1 ? "round" : "rounds"}, ${formatDuration(totalMs(rounds))} in all${kept}`
  }
  return (
    <Frame
      palette={props.palette}
      title="/goal rounds"
      subtitle={subtitle()}
      onClose={props.onClose}
      actions={[
        { label: "expand all", run: () => setOpen(expandAll(props.rounds())) },
        { label: "collapse all", run: () => setOpen(collapseAll()) },
      ]}
    >
      <scrollbox maxHeight={props.maxHeight} focused>
        <For each={newestFirst()}>
          {(round) => (
            <box flexDirection="column" paddingBottom={1}>
              <text fg={outcomeColour(props.palette, round.outcome)} onMouseDown={() => setOpen(toggleOpen(open(), round.n))}>
                {open().has(round.n) ? "▾" : "▸"} #{round.n} {glyph(round.outcome)} {formatDuration(round.ms)}
                {round.reason ? `  ${round.reason}` : ""}
              </text>
              <Show when={open().has(round.n)}>
                <box flexDirection="column" paddingLeft={3}>
                  <text fg={props.palette.base}>{round.achieved}</text>
                  <text fg={props.palette.muted}>
                    {round.toolCalls} tool {round.toolCalls === 1 ? "call" : "calls"} · started{" "}
                    {new Date(round.startedAt).toLocaleTimeString()} · {round.outcome}
                    {round.fallback ? " · no judge summary" : ""}
                  </text>
                </box>
              </Show>
            </box>
          )}
        </For>
      </scrollbox>
    </Frame>
  )
}
