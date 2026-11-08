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
