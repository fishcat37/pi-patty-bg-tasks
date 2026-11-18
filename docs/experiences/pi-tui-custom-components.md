# Custom TUI components in a pi extension (/bg-log)

Findings from building the `/bg-log` live log viewer (`src/log-viewer.ts`),
kept because they are easy to get wrong and hard to rediscover.

## `@earendil-works/pi-tui` is importable, but must be declared

The runtime resolves it for extensions: `pi-coding-agent`'s extension loader
maps the specifier through jiti aliases (dev) and virtual modules (compiled Bun
binary), so `import { getKeybindings, matchesKey, truncateToWidth } from
"@earendil-works/pi-tui"` works without the package being installed next to the
extension. `tsc` still needs it, so it is a `peerDependency` (pi provides it,
same as `pi-coding-agent`) plus a `devDependency` for type checking.

Do not hand-roll key matching instead: pi delivers Kitty CSI-u and
modifyOtherKeys encodings, and `matchesKey` / `KeybindingsManager.matches`
already handle them.

## A non-overlay `ui.custom` component replaces the editor, not the screen

`showExtensionCustom` (non-overlay) clears `editorContainer` and adds the
component there, so the chat above stays visible and the component's height
must stay bounded. The viewer derives its body height from
`process.stdout.rows` with a floor and a cap (`bodyRows` in `src/log-viewer.ts`)
rather than filling the terminal.

## PgUp/PgDn are unreliable; also accept Ctrl+U/Ctrl+D

Inside tmux, PgUp/PgDn enter copy-mode (or pi's scrollback) and never reach the
focused component, so paging keyed only to `tui.select.pageUp/pageDown` looks
broken. The viewer keeps those bindings but advertises and also handles
Ctrl+U/Ctrl+D. Verified interactively in a tmux pane: PgUp did nothing, Ctrl+U
paged by exactly the body height.

## Polling from a component

`setInterval` + `tui.requestRender()` at ~400 ms is enough to follow a growing
log file; `unref()` the timer and `clearInterval` in `dispose()` (pi calls it
when the component closes). pi's renderer skips terminal writes when the
rendered lines are unchanged, so an idle redraw is cheap, and keeping the tick
alive is what keeps the header's duration counting up.

## Pi wraps widget lines and selector options — only the height is limited

Two primitives this extension leans on both wrap rather than clip, so the
extension does not need its own truncation there:

- `ctx.ui.setWidget(key, string[])` wraps each string in `new Text(line, 1, 0)`
  (`setExtensionWidget` in `interactive-mode`), and `Text.render(width)` runs
  `wrapTextWithAnsi`. A row longer than the terminal wraps onto the next row.
  `MAX_WIDGET_LINES = 10` caps the number of **strings**, not the rendered rows,
  so one string containing `\n` (command + progress line) still costs one slot.
- `ctx.ui.select(title, options)` renders options through
  `ExtensionSelectorComponent` → `Text(text, 1, 0)`, so long options wrap too.

`ExtensionSelectorComponent` does not scroll: `maxVisible` is hard-coded to 10.
Panel height therefore grows with the wrapped option height — measured by
rendering the real component at width 80 with ~140-character commands:

| jobs in list | panel height |
|---|---|
| 1 | 11 rows |
| 3 | 17 rows |
| 5 | 23 rows |
| 10 | 38 rows |

The same list with commands cut to 40 characters is 9 / 18 rows, so removing
the cut roughly doubles the height. On a short terminal the bottom of the panel
clips as you navigate. If a bounded-height list is needed, build it with
`ctx.ui.custom` and derive the body height the way `src/log-viewer.ts` does.

Consequence for this extension: `/bg-list` relies on the selector's wrapping
and shows whole commands. The sidebar used to do the same; v2.3.0 moved it to a
component so it can stop each job at exactly one physical row (next section).

## Widget components need `requestRender`, and clicks only exist in fullscreen

`ctx.ui.setWidget(key, string[])` wraps each string, so it cannot make a row
stop at one physical line. The component form —
`setWidget(key, (tui) => component)` — hands `render(width)` the exact available
width and is the only way to cut a line precisely (`truncateToWidth` for the
collapsed sidebar, `wrapTextWithAnsi` for the expanded form).

Three consequences found while building the v2.3.0 sidebar:

- **Every `setWidget` call disposes the previous component.**
  `setExtensionWidget` starts with `removeExisting(...)` for the same key, so
  re-setting the widget (the old string form was re-sent each second) would
  destroy the component and lose any UI state. Mount once, keep the `tui`
  handle, and call `requestRender()` for duration/progress ticks; call
  `setWidget(key, undefined)` only when the widget is no longer needed.
- **Mouse events reach widget components only in fullscreen mode.** The
  fullscreen layout records a box for every rendered component and routes a
  click to the deepest component with `handleMouse`; regular mode leaves the
  mouse to the terminal because it owns scrollback. A handler that toggles
  state must return `{ handled: true, render: true }` so the click does not
  also start transcript selection. Current pi-tui exports `MouseRegion` and
  `TuiMouseEvent`; this extension keeps its own structural `WidgetComponent`
  type so it still compiles against older pi-tui versions without them.
- **RPC/print hosts cannot host a component factory.** RPC's `setWidget`
  ignores function content ("Only support string arrays in RPC mode"), so the
  sidebar keeps a string-line fallback whenever `ctx.mode !== "tui"`.

## Checking the rendering without launching the TUI

Feed the exact string the code produces to the real component instead of
guessing:

```ts
import { Text } from "@earendil-works/pi-tui";
new Text(pill, 1, 0).render(80);   // → the wrapped rows pi will show
```

For the selector, `new ExtensionSelectorComponent(title, options, onSelect,
onCancel, {}).render(80).length` gives the true panel height; it needs
`initTheme("dark")` from `pi-coding-agent/dist/modes/interactive/theme/theme.js`
first. Both work from a plain `node --experimental-strip-types` script against
the installed package — no TUI session required.
