/**
 * The job registry — the single point of truth for every running or
 * recently-terminal background job. All CRUD operations live here.
 *
 * On top of the data store, this module renders the in-session sidebar
 * pill bar (`renderSidebar`) and aggregates stats (`getStats`).
 */

import { randomInt } from "node:crypto";
import { statSync, unlinkSync } from "node:fs";
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { formatDuration, jobLabel, oneLine } from "./format.ts";
import {
    isTerminalStatus,
    JOB_ID_PREFIX,
    MAX_CONCURRENT_JOBS,
    PREVIEW_CHARS,
    RECENT_TERMINAL_KEEP,
    type Job,
    type JobKind,
    type TuiHandle,
    type UiContext,
    type WidgetComponent,
    type WidgetMouseEvent,
    type WidgetMouseResult,
} from "./types.ts";
import type { BackgroundRegistry } from "./state.ts";
import { readBoundedTail, readLastLine } from "./output.ts";

// --- ID generation -------------------------------------------------------

const ID_ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz";

/**
 * Claude Code's typed task ids: a one-letter kind prefix (b/m/a) plus 8 random
 * base36 chars from crypto.randomInt (uniform — no modulo bias) — e.g.
 * `b7f3k9a2x1`. Random (not sequential) so an id is unguessable and
 * collision-improbable across sessions; when the live registry is passed, a
 * collision simply regenerates.
 */
export function newJobId(kind: JobKind, reg?: BackgroundRegistry): string {
    let id: string;
    do {
        let suffix = "";
        for (let i = 0; i < 8; i++) {
            suffix += ID_ALPHABET[randomInt(0, ID_ALPHABET.length)];
        }
        id = `${JOB_ID_PREFIX[kind]}${suffix}`;
    } while (reg?.jobs.has(id));
    return id;
}

/** Dedicated log directory. Keeping logs in their own dir (not loose in /tmp)
 *  keeps the stale-log sweep bounded — it lists only our files. */
export const LOG_DIR = "/tmp/pi-bg";

export function logPathFor(jobId: string): string {
    return `${LOG_DIR}/${jobId}.log`;
}

/** Sibling stderr-capture path for a monitor's split output. Keeps the
 *  `.log`/`.err` naming convention in one place. */
export function errPathFor(jobId: string): string {
    return `${LOG_DIR}/${jobId}.err`;
}

/**
 * Build a fresh running Job. Centralizes the Job shape so the new `kind`/`stop`
 * fields (and any future additions) don't drift across the bash/bash_bg/
 * agent_bg/monitor construction sites.
 */
export function createRunningJob(args: {
    id: string;
    command: string;
    pid: number;
    logPath: string;
    toolCallId: string;
    name?: string;
    kind?: JobKind;
    isBackgrounded?: boolean;
}): Job {
    return {
        id: args.id,
        name: args.name,
        command: args.command,
        pid: args.pid,
        startTime: Date.now(),
        status: "running",
        logPath: args.logPath,
        toolCallId: args.toolCallId,
        isBackgrounded: args.isBackgrounded ?? true,
        kind: args.kind,
    };
}

// --- Registry mutations --------------------------------------------------

/** Record that a job has started (lifetime counter). */
export function markStarted(reg: BackgroundRegistry): void {
    reg.totalStarted++;
}

/** Add a brand-new running job and count it as started. */
export function add(reg: BackgroundRegistry, job: Job): Job {
    reg.jobs.set(job.id, job);
    markStarted(reg);
    return job;
}

/** True once the running-job count has reached the concurrency cap. Counts with
 *  a short-circuit so it stops at the cap instead of scanning the whole map. */
export function atConcurrencyLimit(reg: BackgroundRegistry): boolean {
    let n = 0;
    for (const job of reg.jobs.values()) {
        if (job.status === "running" && ++n >= MAX_CONCURRENT_JOBS) return true;
    }
    return false;
}

/**
 * Remove a terminal job from the live map and update lifetime counters.
 * Returns the removed job (or undefined if it wasn't in the map).
 */
export function forget(reg: BackgroundRegistry, job: Job): Job | undefined {
    if (!reg.jobs.delete(job.id)) return undefined;
    if (job.status === "completed") {
        reg.completedCount++;
        reg.totalDurationMs += terminalDurationMs(job);
    } else if (job.status === "failed") {
        reg.failedCount++;
        reg.totalDurationMs += terminalDurationMs(job);
    } else if (job.status === "killed") {
        reg.killedCount++;
    }
    reg.recentTerminal.push(job);
    if (reg.recentTerminal.length > RECENT_TERMINAL_KEEP) {
        reg.recentTerminal.shift();
    }
    return job;
}

/** Look up a job by ID — first the live registry, then the recent-terminal ring
 *  for jobs that already finished and were evicted. */
export function findJob(reg: BackgroundRegistry, jobId: string): Job | undefined {
    return (
        reg.jobs.get(jobId) ??
        reg.recentTerminal.find((j) => j.id === jobId)
    );
}

/** Purge all terminal jobs from in-memory state and delete their log files. */
export function cleanupTerminal(reg: BackgroundRegistry): {
    purged: number;
    bytesReclaimed: number;
} {
    let purged = 0;
    let bytes = 0;
    const deletedLogs = new Set<string>();
    const deleteOnce = (logPath: string): number => {
        if (deletedLogs.has(logPath)) return 0;
        deletedLogs.add(logPath);
        return deleteLogFile(logPath);
    };

    const idsToRemove: string[] = [];
    for (const [id, job] of reg.jobs.entries()) {
        if (isTerminalStatus(job.status)) {
            idsToRemove.push(id);
            bytes += deleteOnce(job.logPath);
            purged++;
        }
    }
    for (const id of idsToRemove) {
        reg.jobs.delete(id);
    }
    // The recent-terminal ring is all terminal jobs too — sweep their logs.
    for (const job of reg.recentTerminal) {
        bytes += deleteOnce(job.logPath);
        purged++;
    }
    reg.recentTerminal.length = 0;
    return { purged, bytesReclaimed: bytes };
}

function deleteLogFile(logPath: string): number {
    try {
        const { size } = statSync(logPath);
        unlinkSync(logPath);
        return size;
    } catch {
        return 0;
    }
}

// ─── Sidebar rendering ───────────────────────────────────────────────────

/** One widget key for the whole extension (above the editor). */
const SIDEBAR_WIDGET_KEY = "background-jobs";

/** Running jobs in insertion order. Terminal jobs render no pill: their
 *  outcome is always surfaced by a <task-notification>, a kill, or a read. */
function runningJobs(reg: BackgroundRegistry): Job[] {
    const jobs: Job[] = [];
    for (const job of reg.jobs.values()) {
        if (!isTerminalStatus(job.status)) jobs.push(job);
    }
    return jobs;
}

function pillHead(job: Job): string {
    const glyph = job.kind === "monitor" ? "◉" : "▶";
    return `${glyph} ${oneLine(jobLabel(job))}: `;
}

/** Inner width after the one-column margins Text-style widgets use. */
function widgetInnerWidth(width: number): number {
    return Math.max(1, width - 2);
}

/** Pad a rendered widget line to the full width (or cut it if the terminal is
 *  narrower than the margins). Every returned line is one physical row. */
function fitWidgetLine(text: string, width: number): string {
    const inner = widgetInnerWidth(width);
    const line = ` ${truncateToWidth(text, inner, "…", true)} `;
    return visibleWidth(line) <= width ? line : truncateToWidth(line, width, "…", true);
}

/** Collapsed widget: exactly one row per running job. The duration survives
 *  the cut; only the command is shortened. */
function collapsedSidebarLines(reg: BackgroundRegistry, width: number): string[] {
    const inner = widgetInnerWidth(width);
    return runningJobs(reg).map((job) => {
        const head = pillHead(job);
        const suffix = ` (${formatDuration(Date.now() - job.startTime)})`;
        const budget = inner - visibleWidth(head) - visibleWidth(suffix);
        const command = oneLine(job.command);
        const text = budget > 1
            ? `${head}${truncateToWidth(command, budget, "…")}${suffix}`
            : `${head}${command}${suffix}`;
        return fitWidgetLine(text, width);
    });
}

/** Expanded widget: the full command (wrapped) plus the latest output row. */
function expandedSidebarLines(reg: BackgroundRegistry, width: number): string[] {
    const inner = widgetInnerWidth(width);
    const lines: string[] = [];
    for (const job of runningJobs(reg)) {
        const duration = formatDuration(Date.now() - job.startTime);
        const command = `${pillHead(job)}${oneLine(job.command)} (${duration})`;
        for (const line of wrapTextWithAnsi(command, inner)) {
            lines.push(fitWidgetLine(line, width));
        }
        const progress = sidebarLastLine(job.logPath);
        if (progress) {
            const progressLine = `   ↳ ${progress.slice(0, PREVIEW_CHARS.progress)}`;
            for (const line of wrapTextWithAnsi(progressLine, inner)) {
                lines.push(fitWidgetLine(line, width));
            }
        }
    }
    return lines;
}

/** String form for hosts without component widgets (RPC/print). The host owns
 *  the width, so the command stays whole and the host wraps it. */
function stringSidebarLines(reg: BackgroundRegistry): string[] {
    return runningJobs(reg).map((job) => {
        const duration = formatDuration(Date.now() - job.startTime);
        const pill = `${pillHead(job)}${oneLine(job.command)} (${duration})`;
        const progress = sidebarLastLine(job.logPath);
        return progress
            ? `${pill}\n   ↳ ${progress.slice(0, PREVIEW_CHARS.progress)}`
            : pill;
    });
}

/**
 * The above-editor task widget. Collapsed (default) it is one row per running
 * job with the command cut to fit; a click expands every job to its full
 * command and latest output row, and another click collapses it again.
 *
 * Mounted once per session through the component form of setWidget: pi disposes
 * the widget with the same key on every setWidget call, so re-setting it (as the
 * old string form did) would drop the expanded state and the mouse identity. The
 * 1 Hz ticker keeps durations and progress live through requestRender.
 */
export class SidebarWidget implements WidgetComponent {
    private readonly reg: BackgroundRegistry;
    private readonly tui: TuiHandle;

    constructor(reg: BackgroundRegistry, tui: TuiHandle) {
        this.reg = reg;
        this.tui = tui;
    }

    render(width: number): string[] {
        return this.reg.sidebarExpanded
            ? expandedSidebarLines(this.reg, width)
            : collapsedSidebarLines(this.reg, width);
    }

    handleMouse(event: WidgetMouseEvent): WidgetMouseResult | undefined {
        // Only a primary click toggles. Wheel, drag and release stay unhandled
        // so fullscreen scrolling and transcript selection keep working.
        if (event.type !== "click" || event.button !== "left") return undefined;
        this.reg.sidebarExpanded = !this.reg.sidebarExpanded;
        this.tui.requestRender();
        return { handled: true, render: true };
    }

    invalidate(): void {
        // Everything is read live on render; there is no cached layout.
    }

    dispose(): void {
        // pi drops the widget on session teardown. Clear the handle only when
        // it is still ours: a replacement mounts its factory after disposing
        // this component, and that factory sets the new handle.
        if (this.reg.sidebarTui === this.tui) {
            this.reg.sidebarTui = undefined;
            this.reg.sidebarMounted = false;
        }
    }
}

/**
 * Render the widget and aggregate status-bar text, and keep the 1 Hz ticker
 * running while any job is alive so durations and progress stay live. Call
 * after any state change that affects running jobs.
 */
export function renderSidebar(reg: BackgroundRegistry, ctx: UiContext): void {
    const jobs = runningJobs(reg);

    // Drop progress-cache entries for logs no longer tracked.
    const runningLogs = new Set(jobs.map((job) => job.logPath));
    for (const key of sidebarLineCache.keys()) {
        if (!runningLogs.has(key)) sidebarLineCache.delete(key);
    }

    if (jobs.length === 0) {
        stopSidebarTicker(reg);
        if (reg.sidebarMounted) {
            reg.sidebarMounted = false;
            reg.sidebarTui = undefined;
            reg.sidebarExpanded = false;
            reg.lastSidebarStatus = undefined;
            ctx.ui.setWidget(SIDEBAR_WIDGET_KEY, undefined);
            ctx.ui.setStatus(SIDEBAR_WIDGET_KEY, undefined);
        }
        return;
    }

    // Mount once; later updates only repaint. setWidget would dispose the
    // component and lose its expanded state.
    const componentHost = ctx.mode === undefined || ctx.mode === "tui";
    if (!reg.sidebarMounted) {
        if (componentHost) {
            ctx.ui.setWidget(SIDEBAR_WIDGET_KEY, (tui) => {
                reg.sidebarMounted = true;
                reg.sidebarTui = tui;
                return new SidebarWidget(reg, tui);
            });
        } else {
            reg.sidebarMounted = true;
        }
    }

    const parts = [`${jobs.length} running`];
    if (reg.completedCount > 0) parts.push(`${reg.completedCount} done`);
    if (reg.failedCount > 0) parts.push(`${reg.failedCount} failed`);
    const statusText = `▶ ${parts.join(", ")}`;
    if (statusText !== reg.lastSidebarStatus) {
        reg.lastSidebarStatus = statusText;
        ctx.ui.setStatus(SIDEBAR_WIDGET_KEY, ctx.ui.theme.fg("accent", statusText));
    }

    // The ticker drives durations/progress; event-driven calls repaint too.
    if (componentHost) {
        reg.sidebarTui?.requestRender();
    } else {
        // RPC/print hosts cannot host a component: send string lines, which
        // their renderer wraps. There is no click-to-expand there.
        ctx.ui.setWidget(SIDEBAR_WIDGET_KEY, stringSidebarLines(reg));
    }
    ensureSidebarTicker(reg, ctx);
}

/** Reset the mount flags when the UI changes underneath us (session reload,
 *  fork, switch). The widget itself belonged to the previous UI; renderSidebar
 *  mounts a fresh component on the next call. */
export function resetSidebarWidget(reg: BackgroundRegistry): void {
    stopSidebarTicker(reg);
    reg.sidebarMounted = false;
    reg.sidebarTui = undefined;
    reg.sidebarExpanded = false;
    reg.lastSidebarStatus = undefined;
    sidebarLineCache.clear();
}

/** Per-log cache for the sidebar's live progress line: the 1 Hz ticker would
 *  otherwise re-read every running job's tail every tick even when output is
 *  static. statSync first; skip the read when the size is unchanged. */
const sidebarLineCache = new Map<string, { size: number; lastLine: string }>();

function sidebarLastLine(logPath: string): string {
    let size: number;
    try {
        size = statSync(logPath).size;
    } catch {
        sidebarLineCache.delete(logPath);
        return "";
    }
    const cached = sidebarLineCache.get(logPath);
    if (cached && cached.size === size) return cached.lastLine;
    const lastLine = readLastLine(logPath);
    sidebarLineCache.set(logPath, { size, lastLine });
    return lastLine;
}

/** Start the live-duration ticker if not already running. */
function ensureSidebarTicker(reg: BackgroundRegistry, ctx: UiContext): void {
    if (reg.sidebarTimer) return;
    const t = setInterval(() => {
        try {
            renderSidebar(reg, ctx);
        } catch {
            // The captured ctx went stale (session reload/fork/switch) — stop
            // ticking rather than throw an uncaught exception in the interval.
            stopSidebarTicker(reg);
        }
    }, 1000);
    t.unref();
    reg.sidebarTimer = t;
}

/** Stop the live-duration ticker (no running jobs, or on shutdown). */
export function stopSidebarTicker(reg: BackgroundRegistry): void {
    if (reg.sidebarTimer) {
        clearInterval(reg.sidebarTimer);
        reg.sidebarTimer = undefined;
    }
}

// ─── Stats ───────────────────────────────────────────────────────────────

export interface JobStats {
    totalStarted: number;
    running: number;
    completed: number;
    failed: number;
    killed: number;
    recentTerminal: number;
    averageDurationMs: number;
    totalDurationMs: number;
}

export function getStats(reg: BackgroundRegistry): JobStats {
    let running = 0;
    for (const job of reg.jobs.values()) {
        if (job.status === "running") running++;
    }
    const terminalCount = reg.completedCount + reg.failedCount;
    return {
        totalStarted: reg.totalStarted,
        running,
        completed: reg.completedCount,
        failed: reg.failedCount,
        killed: reg.killedCount,
        recentTerminal: reg.recentTerminal.length,
        averageDurationMs:
            terminalCount > 0
                ? Math.round(reg.totalDurationMs / terminalCount)
                : 0,
        totalDurationMs: reg.totalDurationMs,
    };
}

// ─── Internal helpers ──────────────────────────────────────────────────

function terminalDurationMs(job: Job): number {
    return Date.now() - job.startTime;
}

// ─── Status helpers (used by tools and shortcuts) ───────────────────────────────────────────

/** True when the job is currently in the running state. */
export function isRunning(job: Job): boolean {
    return job.status === "running";
}

/** Read only the tail of a job's log file — O(maxChars) even for large files. */
export function readLogTail(job: Job, maxChars: number): string {
    return readBoundedTail(job.logPath, maxChars);
}
