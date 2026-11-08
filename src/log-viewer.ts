/**
 * /bg-log — the live log viewer.
 *
 * A read-only scrolling view of one job's output. Mounted through
 * ctx.ui.custom() so it can keep following the file while the job runs: the log
 * is polled, new lines are appended, and the view stays pinned to the bottom
 * until you scroll up. That is the piece /bg-list never had — its "Show Output"
 * was a frozen 12k-character snapshot in an editor.
 *
 * A monitor's stderr is captured to a sibling `.err` file (`errPathFor`), so the
 * viewer opens it as a second source and `e` flips between them. Everything
 * else — shell and agent jobs — merges stderr into the main log and has one
 * source.
 *
 * Keys: ↑/↓ (or j/k) scroll · Ctrl+U/Ctrl+D page · g load older output ·
 *       G jump to bottom · f toggle follow · e flip stdout/stderr · q/Esc close.
 */

import { existsSync } from "node:fs";
import { getKeybindings, matchesKey, Key, truncateToWidth } from "@earendil-works/pi-tui";
import { formatDuration, jobLabel, statusIcon } from "./format.ts";
import {
    atWindowLimit,
    extendBackward,
    extendForward,
    olderBytes,
    tailWindow,
    type LogWindow,
} from "./log-window.ts";
import { errPathFor, readLogTail } from "./registry.ts";
import { OUTPUT_PREVIEW_CHARS, type Job, type TuiHandle, type UiContext, type ViewerComponent, type UiTheme } from "./types.ts";

/** How often the open viewer re-reads the log. */
const FOLLOW_POLL_MS = 400;
/** Body rows are bounded so the view never eats the whole chat viewport. */
const MIN_BODY_ROWS = 8;
const MAX_BODY_ROWS = 32;
/** Rows left above the viewer for the conversation. */
const RESERVED_ROWS = 12;

// Remaining C0 controls / DEL; ESC is kept so log colours survive. \r is
// handled separately (progress bars redraw the same line).
const CONTROL_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

/** Body height for a terminal `termRows` tall. */
export function bodyRows(termRows: number): number {
    return Math.max(MIN_BODY_ROWS, Math.min(MAX_BODY_ROWS, termRows - RESERVED_ROWS));
}

/** One file the viewer reads: the job's log, or a monitor's stderr. Each keeps
 *  its own window and scroll position so `e` can flip back and forth. */
interface LogSource {
    stderr: boolean;
    path: string;
    win: LogWindow;
    scrollTop: number;
    follow: boolean;
}

/** The job's own log first, then its stderr when the monitor tool captured one
 *  (the file only exists for command monitors — ws monitors have no process). */
function openSources(job: Job): LogSource[] {
    const sources: LogSource[] = [source(false, job.logPath)];
    const errPath = errPathFor(job.id);
    if (errPath !== job.logPath && existsSync(errPath)) sources.push(source(true, errPath));
    return sources;
}

function source(stderr: boolean, path: string): LogSource {
    return { stderr, path, win: tailWindow(path), scrollTop: 0, follow: true };
}

export interface LogViewerHost {
    job: Job;
    tui: TuiHandle;
    theme: UiTheme;
    onClose: () => void;
    /** Terminal height in rows (default: the real terminal). */
    rows?: () => number;
    /** Log poll cadence in ms; 0 disables polling (tests). */
    pollMs?: number;
}

export class LogViewer implements ViewerComponent {
    private readonly job: Job;
    private readonly tui: TuiHandle;
    private readonly theme: UiTheme;
    private readonly onClose: () => void;
    private readonly termRows: () => number;
    private readonly pollMs: number;

    private readonly sources: LogSource[];
    private active = 0;
    private closed = false;
    private timer: NodeJS.Timeout | undefined;

    constructor(host: LogViewerHost) {
        this.job = host.job;
        this.tui = host.tui;
        this.theme = host.theme;
        this.onClose = host.onClose;
        this.termRows = host.rows ?? (() => process.stdout.rows || 30);
        this.pollMs = host.pollMs ?? FOLLOW_POLL_MS;
        this.sources = openSources(this.job);
    }

    /** Begin following the log. Safe to call once; see dispose(). */
    start(): void {
        if (this.pollMs <= 0) return;
        this.timer = setInterval(() => this.poll(), this.pollMs);
        this.timer.unref();
    }

    /** The source on screen (log, or the monitor's stderr after `e`). */
    private get source(): LogSource {
        return this.sources[this.active];
    }

    dispose(): void {
        this.closed = true;
        if (this.timer) clearInterval(this.timer);
        this.timer = undefined;
    }

    handleInput(data: string): void {
        const kb = getKeybindings();
        if (kb.matches(data, "tui.select.cancel") || data === "q") return this.close();
        if (kb.matches(data, "tui.select.up") || data === "k") return this.scrollBy(-1);
        if (kb.matches(data, "tui.select.down") || data === "j") return this.scrollBy(1);
        if (kb.matches(data, "tui.select.pageUp") || matchesKey(data, Key.ctrl("u"))) {
            return this.scrollBy(-this.bodyHeight());
        }
        if (kb.matches(data, "tui.select.pageDown") || matchesKey(data, Key.ctrl("d"))) {
            return this.scrollBy(this.bodyHeight());
        }
        if (matchesKey(data, Key.home)) return this.scrollBy(-Number.MAX_SAFE_INTEGER);
        if (matchesKey(data, Key.end) || data === "G") return this.jumpToBottom();
        if (data === "g") return this.loadOlder();
        if (data === "f") return this.setFollow(!this.source.follow);
        if (data === "e") return this.flipSource();
    }

    render(width: number): string[] {
        const height = this.bodyHeight();
        const src = this.source;
        const total = totalLines(src.win);
        const maxTop = Math.max(0, total - height);
        if (src.follow) src.scrollTop = maxTop;
        else src.scrollTop = Math.min(src.scrollTop, maxTop);

        const out = [this.headerLine(), this.metaLine()];
        for (let row = 0; row < height; row++) {
            if (total === 0) {
                out.push(row === 0 ? this.noticeLine() : "");
                continue;
            }
            const line = lineAt(src.win, src.scrollTop + row);
            out.push(line === undefined ? "" : truncateToWidth(line, width));
        }
        out.push(this.footerLine());
        return out;
    }

    invalidate(): void {
        // Nothing cached — every render reads the current window.
    }

    // ─── log polling ─────────────────────────────────────────────────────

    private poll(): void {
        if (this.closed) return;
        for (const src of this.sources) {
            const grown = extendForward(src.path, src.win);
            if (grown) src.win = grown;
        }
        // Redraw even without new output: the header's duration keeps moving
        // and pi's renderer skips the terminal write when nothing changed.
        this.tui.requestRender();
    }

    // ─── viewport ────────────────────────────────────────────────────────

    private bodyHeight(): number {
        return bodyRows(this.termRows());
    }

    private scrollBy(delta: number): void {
        const src = this.source;
        const maxTop = Math.max(0, totalLines(src.win) - this.bodyHeight());
        src.scrollTop = Math.max(0, Math.min(maxTop, src.scrollTop + delta));
        src.follow = src.scrollTop >= maxTop;
        this.tui.requestRender();
    }

    private jumpToBottom(): void {
        this.source.follow = true;
        this.tui.requestRender();
    }

    private setFollow(follow: boolean): void {
        this.source.follow = follow;
        this.tui.requestRender();
    }

    private loadOlder(): void {
        const src = this.source;
        const older = extendBackward(src.path, src.win);
        if (!older) return;
        // Keep the line you were reading in place: the view grew at the top.
        src.scrollTop += older.lines.length - src.win.lines.length;
        src.win = older;
        this.tui.requestRender();
    }

    /** `e`: flip between the log and a monitor's captured stderr. */
    private flipSource(): void {
        if (this.sources.length < 2) return;
        this.active = (this.active + 1) % this.sources.length;
        // Catch up on whatever landed while this source was off screen.
        const src = this.source;
        const grown = extendForward(src.path, src.win);
        if (grown) src.win = grown;
        this.tui.requestRender();
    }

    private close(): void {
        if (this.closed) return;
        this.dispose();
        this.onClose();
    }

    // ─── rendering ───────────────────────────────────────────────────────

    private headerLine(): string {
        const label = `${jobLabel(this.job)} (${this.job.id})`;
        const exit = this.job.exitCode !== undefined ? ` · exit ${this.job.exitCode}` : "";
        return this.theme.fg("accent", `${statusIcon(this.job)} ${label}`) +
            this.theme.fg("dim", ` · ${this.statusText()}${exit}`);
    }

    /** "running (1m15s)" / "completed" — the icon already carries the state,
     *  so the pill prefix from statusLabel() would repeat itself here. */
    private statusText(): string {
        if (this.job.status !== "running") return this.job.status;
        return `running (${formatDuration(Date.now() - this.job.startTime)})`;
    }

    private metaLine(): string {
        const src = this.source;
        const shown = formatBytes(src.win.end - src.win.start);
        const older = olderBytes(src.win);
        const parts = [`${src.stderr ? "Stderr" : "Log"}: ${src.path}`, `${shown} loaded`];
        if (older > 0) {
            parts.push(`${formatBytes(older)} older${atWindowLimit(src.win) ? " (window full)" : ""}`);
        }
        return this.theme.fg("dim", parts.join(" · "));
    }

    private noticeLine(): string {
        const what = this.source.stderr ? "stderr" : "output";
        return this.theme.fg(
            "dim",
            this.job.status === "running" ? `  (no ${what} yet)` : `  (no ${what})`
        );
    }

    private footerLine(): string {
        // PgUp/PgDn are the expected keys, but tmux copy-mode and some terminals
        // swallow them, so Ctrl+U/Ctrl+D page too and are what the hint shows.
        const src = this.source;
        const hints = ["↑↓ scroll", "^U/^D page", `f follow:${src.follow ? "on" : "off"}`];
        if (olderBytes(src.win) > 0 && !atWindowLimit(src.win)) hints.push("g older");
        if (this.sources.length > 1) hints.push(src.stderr ? "e log" : "e stderr");
        hints.push("q close");
        return this.theme.fg("dim", hints.join("  ·  "));
    }
}

/** Window lines plus the unterminated line the job is still writing. */
function totalLines(win: LogWindow): number {
    return win.lines.length + (win.pending ? 1 : 0);
}

/** One display line by index, sanitized — only what's on screen gets cleaned,
 *  so a huge window costs the same per render as a small one. */
function lineAt(win: LogWindow, index: number): string | undefined {
    if (index < win.lines.length) return sanitizeLine(win.lines[index]);
    if (index === win.lines.length && win.pending) return sanitizeLine(win.pending);
    return undefined;
}

// ─── mounting ───────────────────────────────────────────────────────────

/**
 * Open the live log viewer for one job. Falls back to a static snapshot outside
 * the TUI (RPC/print stub custom() out with an immediate undefined).
 */
export async function openLogViewer(job: Job, ctx: UiContext): Promise<void> {
    // Out of the TUI there is no component host: RPC/print stub custom() out.
    if (typeof ctx.ui.custom !== "function" || (ctx.mode ?? "tui") !== "tui") {
        await showSnapshot(job, ctx);
        return;
    }
    await ctx.ui.custom((tui, theme, _keybindings, done) => {
        const viewer = new LogViewer({ job, tui, theme, onClose: () => done(undefined) });
        viewer.start();
        return viewer;
    });
}

/** Non-TUI fallback: one frozen tail in the editor, like the old panel. */
async function showSnapshot(job: Job, ctx: UiContext): Promise<void> {
    const out = readLogTail(job, OUTPUT_PREVIEW_CHARS);
    const exit = job.exitCode !== undefined ? `\nExit code: ${job.exitCode}` : "";
    await ctx.ui.editor(
        `${statusIcon(job)} ${jobLabel(job)} (${job.id})`,
        `Command: ${job.command}\n` +
            `PID: ${job.pid} · Started: ${new Date(job.startTime).toLocaleString()}\n` +
            `Duration: ${formatDuration(Date.now() - job.startTime)} · Status: ${job.status}${exit}\n` +
            `Log: ${job.logPath}\n\n--- OUTPUT ---\n${out}`
    );
}

// ─── formatting helpers ─────────────────────────────────────────────────

/** One-line log rendering: keep the last \r segment, drop control characters. */
function sanitizeLine(line: string): string {
    const lastCarriageReturn = line.lastIndexOf("\r");
    const body = lastCarriageReturn >= 0 ? line.slice(lastCarriageReturn + 1) : line;
    return body.replace(CONTROL_CHARS, "").replace(/\t/g, "    ");
}

function formatBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KiB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}
