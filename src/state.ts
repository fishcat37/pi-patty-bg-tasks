/**
 * Shared mutable state for the background-tasks extension.
 *
 * One instance per session, threaded through every tool and helper.
 */

import type { Job, ForegroundSlot, TuiHandle } from "./types.ts";

export class BackgroundRegistry {
    jobs = new Map<string, Job>();
    foreground = new Map<string, ForegroundSlot>();

    /** Per-job AbortController — abort() cancels all monitors/pollers for that job. */
    jobAborts = new Map<string, AbortController>();

    nonInteractive = false;

    completedCount = 0;
    failedCount = 0;
    killedCount = 0;
    totalStarted = 0;
    totalDurationMs = 0;
    recentTerminal: Job[] = [];

    /** Live-duration ticker for the sidebar pills; runs while jobs are alive. */
    sidebarTimer: NodeJS.Timeout | undefined = undefined;
    /** True while the component widget is mounted in this session's UI. pi
     *  removes the previous widget on every setWidget call, so the component is
     *  mounted once and thereafter updated through requestRender. */
    sidebarMounted = false;
    /** The mounted widget's TUI handle — requestRender after a state change. */
    sidebarTui: TuiHandle | undefined = undefined;
    /** Click-to-expand state: false = one row per job, true = full command and
     *  the latest output row. Reset when the widget empties. */
    sidebarExpanded = false;
    /** Last status-bar text, to skip redundant setStatus calls. */
    lastSidebarStatus: string | undefined = undefined;
}
