/**
 * Background tasks TUI panel — the /bg-list interactive manager and the
 * /bg-log job picker.
 *
 * Uses Pi's ctx.ui.select()/custom() primitives (available in both command and
 * shortcut contexts) to provide Claude Code-style job management:
 * - pick a job from the list
 * - read its log in the live viewer / kill / remove it
 */

import type { Job, UiContext } from "./types.ts";
import type { BackgroundRegistry } from "./state.ts";
import { formatDuration, jobLabel, oneLine, orderedJobs, statusIcon } from "./format.ts";
import { terminateJobSilently } from "./lifecycle.ts";
import { forget, renderSidebar } from "./registry.ts";
import { openLogViewer } from "./log-viewer.ts";

export async function openBgListPanel(
    reg: BackgroundRegistry,
    ctx: UiContext
): Promise<void> {
    // Use select()-based panel (works in both command and shortcut contexts).
    while (true) {
        const job = await pickJob("Background Tasks", reg, ctx);
        if (!job) return;
        if (!(await showJobActions(job, reg, ctx))) return;
    }
}

/**
 * /bg-log without an argument: pick a job, read its log, then come back to the
 * list — the log viewer's only action is "close", so this loop is the whole
 * interaction.
 */
export async function openBgLogPicker(
    reg: BackgroundRegistry,
    ctx: UiContext
): Promise<void> {
    while (true) {
        const job = await pickJob("Background Logs", reg, ctx);
        if (!job) return;
        await openLogViewer(job, ctx);
    }
}

/** Show the job list and return the chosen job (undefined when none / Esc). */
async function pickJob(
    title: string,
    reg: BackgroundRegistry,
    ctx: UiContext
): Promise<Job | undefined> {
    const jobs = orderedJobs(reg.jobs.values());
    if (jobs.length === 0) {
        ctx.ui.notify("No background tasks", "info");
        return undefined;
    }
    const items = jobs.map(jobListLine);
    const choice = await ctx.ui.select(title, items);
    if (choice === undefined) return undefined;
    return jobs[items.indexOf(choice)];
}

function jobListLine(job: Job): string {
    const label = job.name ? `${job.name} (${job.id})` : job.id;
    const status = job.status === "running"
        ? `running (${formatDuration(Date.now() - job.startTime)})`
        : job.status;
    // The whole command — the selector wraps a long option to the terminal
    // width instead of dropping the tail.
    return `${statusIcon(job)} ${label}: ${oneLine(job.command)} · ${status}`;
}

async function showJobActions(
    job: Job,
    reg: BackgroundRegistry,
    ctx: UiContext
): Promise<boolean> {
    const name = jobLabel(job);

    if (job.status === "running") {
        const options = ["Show Log", "Kill", "← Back"];
        const action = await ctx.ui.select(
            `▶ ${name} · ${oneLine(job.command)}`,
            options
        );
        if (action === undefined) return false;
        if (action === "Show Log") { await openLogViewer(job, ctx); return true; }
        if (action === "Kill") {
            terminateJobSilently(reg, job);
            renderSidebar(reg, ctx);
            ctx.ui.notify(`Killed ${name}`, "info");
            return true;
        }
        return true;
    }

    const options = ["Show Log", "Remove", "← Back"];
    const action = await ctx.ui.select(`${statusIcon(job)} ${name} · ${job.status}`, options);
    if (action === undefined) return false;
    if (action === "Show Log") { await openLogViewer(job, ctx); return true; }
    if (action === "Remove") {
        forget(reg, job);
        renderSidebar(reg, ctx);
        ctx.ui.notify(`Removed ${name}`, "info");
        return true;
    }
    return true;
}
