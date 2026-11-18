import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readLastLine } from "../output.ts";
import { BackgroundRegistry } from "../state.ts";
import { add, renderSidebar, createRunningJob } from "../registry.ts";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { UiContext, WidgetComponent, WidgetComponentFactory } from "../types.ts";

const dir = mkdtempSync(join(tmpdir(), "pi-progress-"));
const ESC = String.fromCharCode(27);

function tmpLog(name: string, content: string): string {
    const p = join(dir, name);
    writeFileSync(p, content);
    return p;
}

void describe("readLastLine — live progress source", () => {
    void it("returns the last non-empty line", () => {
        const p = tmpLog("a.log", "line one\nline two\nline three\n");
        assert.equal(readLastLine(p), "line three");
    });

    void it("ignores trailing blank lines", () => {
        const p = tmpLog("b.log", "real progress\n\n\n");
        assert.equal(readLastLine(p), "real progress");
    });

    void it("strips ANSI colour codes but keeps literal brackets (JSON)", () => {
        const p = tmpLog("c.log", `${ESC}[32m{"indexed":[1,2,3],"status":"grey"}${ESC}[0m\n`);
        assert.equal(readLastLine(p), '{"indexed":[1,2,3],"status":"grey"}');
    });

    void it("collapses a carriage-return progress bar to its final segment", () => {
        const p = tmpLog("d.log", "downloading 10%\rdownloading 50%\rdownloading 99%");
        assert.equal(readLastLine(p), "downloading 99%");
    });

    void it("strips OSC sequences, tabs, and stray control chars (no escape injection)", () => {
        const BEL = String.fromCharCode(7);
        const p = tmpLog(
            "f.log",
            `${ESC}]0;window-title${BEL}col1\tcol2${BEL} done\n`
        );
        const out = readLastLine(p);
        assert.doesNotMatch(out, /window-title/, "OSC title sequence stripped");
        assert.doesNotMatch(out, new RegExp(`[${ESC}${BEL}\\t]`), "no control chars remain");
        assert.match(out, /col1 col2 done/);
    });

    void it("returns empty string when there is no output yet", () => {
        const p = tmpLog("e.log", "");
        assert.equal(readLastLine(p), "");
    });

    void it("returns empty string for a missing file", () => {
        assert.equal(readLastLine(join(dir, "nope.log")), "");
    });
});

void describe("renderSidebar — compact pills and click-to-expand", () => {
    /** pi-tui's truncateToWidth brackets its ellipsis with SGR resets, so text
     *  assertions run on the escape-free view of a row. */
    const plain = (line: string): string => line.replace(/\x1b\[[0-9;]*m/g, "");

    /** Widget harness: pi calls the component factory once per mount, then the
     *  component is repainted through the tui handle it received. */
    function ctxStub() {
        let component: WidgetComponent | undefined;
        let mounts = 0;
        let unmounts = 0;
        let renders = 0;

        const setWidget = (
            _name: string,
            content: string[] | WidgetComponentFactory | undefined
        ): void => {
            // Match pi: setting a key disposes the widget it already holds.
            component?.dispose?.();
            if (typeof content === "function") {
                mounts++;
                component = content({ requestRender: () => { renders++; } });
                return;
            }
            if (content === undefined && component !== undefined) unmounts++;
            component = undefined;
        };

        const ctx = {
            ui: {
                notify() {},
                setWidget,
                setStatus() {},
                theme: { fg: (_c: string, t: string) => t },
            },
        } as unknown as UiContext;

        return {
            ctx,
            component: () => component,
            lines: (width = 80) => component?.render(width) ?? [],
            mounts: () => mounts,
            unmounts: () => unmounts,
            renders: () => renders,
        };
    }

    const LONG_COMMAND =
        "cd /home/wang/code/competition/name-that-llm && uv run python scripts/train/frozen_feature_probe.py --fold 3 --limit 0";

    void it("collapses to one row per job, cutting the command but keeping the duration", () => {
        const reg = new BackgroundRegistry();
        const logPath = tmpLog("compact.log", '{"indexed":8540629,"status":"grey"}\n');
        add(reg, createRunningJob({
            id: "job-1-1",
            command: LONG_COMMAND,
            pid: 123,
            logPath,
            toolCallId: "t",
        }));

        const h = ctxStub();
        renderSidebar(reg, h.ctx);

        const lines = h.lines(80);
        assert.equal(lines.length, 1, "one job is one row");
        assert.ok(plain(lines[0]).startsWith(" ▶ job-1-1: "), "the label and glyph lead the row");
        assert.match(plain(lines[0]), /… \(0s\)/, "the cut command ends with an ellipsis before the duration");
        assert.ok(!plain(lines[0]).includes(LONG_COMMAND), "the full command is not shown");
        assert.ok(!plain(lines[0]).includes("↳"), "no progress row while collapsed");
        assert.ok(visibleWidth(lines[0]) <= 80, "the row fits the terminal width");
    });

    void it("keeps every job on its own row, even at a narrow width", () => {
        const reg = new BackgroundRegistry();
        const first = tmpLog("first.log", "");
        const second = tmpLog("second.log", "");
        add(reg, createRunningJob({
            id: "job-1-2",
            command: LONG_COMMAND,
            pid: 124,
            logPath: first,
            toolCallId: "t",
        }));
        add(reg, createRunningJob({
            id: "job-1-3",
            command: "tail -f train.log | grep --line-buffered error",
            pid: 125,
            logPath: second,
            toolCallId: "t",
            kind: "monitor",
        }));

        const h = ctxStub();
        renderSidebar(reg, h.ctx);

        const lines = h.lines(40);
        assert.equal(lines.length, 2, "two jobs, two rows");
        assert.ok(lines.every((line) => visibleWidth(line) <= 40), "every row fits 40 columns");
        assert.match(plain(lines[1]), /◉ job-1-3:/, "the monitor keeps its glyph");
    });

    void it("a primary click expands to the full command and the latest output", () => {
        const reg = new BackgroundRegistry();
        const logPath = tmpLog("expand.log", '{"indexed":8540629,"status":"grey"}\n');
        add(reg, createRunningJob({
            id: "job-1-4",
            command: LONG_COMMAND,
            pid: 126,
            logPath,
            toolCallId: "t",
        }));

        const h = ctxStub();
        renderSidebar(reg, h.ctx);
        const before = h.renders();

        h.component()!.handleMouse!({ type: "click", button: "left" });
        assert.equal(reg.sidebarExpanded, true, "the click expands the widget");
        assert.ok(h.renders() > before, "the click asks pi to repaint");

        const lines = h.lines(80);
        assert.ok(lines.length > 1, "the full command wraps instead of being cut");
        assert.ok(
            lines.map(plain).join(" ").includes("--fold 3 --limit 0"),
            "the command's tail is visible after expanding"
        );
        assert.ok(
            lines.map(plain).some((line) => line.includes("↳") && line.includes('"indexed":8540629')),
            "the latest output row comes back"
        );
        assert.ok(lines.every((line) => visibleWidth(line) <= 80), "expanded rows still fit");

        h.component()!.handleMouse!({ type: "click", button: "left" });
        assert.equal(reg.sidebarExpanded, false, "a second click collapses it");
        assert.equal(h.lines(80).length, 1, "back to one row");
    });

    void it("leaves wheel and non-primary clicks alone", () => {
        const reg = new BackgroundRegistry();
        add(reg, createRunningJob({
            id: "job-1-5",
            command: "npm run build",
            pid: 127,
            logPath: tmpLog("wheel.log", ""),
            toolCallId: "t",
        }));
        const h = ctxStub();
        renderSidebar(reg, h.ctx);

        assert.equal(h.component()!.handleMouse!({ type: "wheel", button: "none" }), undefined);
        assert.equal(h.component()!.handleMouse!({ type: "click", button: "right" }), undefined);
        assert.equal(reg.sidebarExpanded, false, "only a primary click toggles");
    });

    void it("mounts the component once and repaints on later updates", () => {
        const reg = new BackgroundRegistry();
        add(reg, createRunningJob({
            id: "job-1-6",
            command: "npm run build",
            pid: 128,
            logPath: tmpLog("mount.log", ""),
            toolCallId: "t",
        }));
        const h = ctxStub();

        renderSidebar(reg, h.ctx);
        const mounted = h.component();
        renderSidebar(reg, h.ctx);

        assert.equal(h.mounts(), 1, "setWidget's factory runs only on mount");
        assert.equal(h.component(), mounted, "later updates reuse the component");
        assert.ok(h.renders() >= 2, "each renderSidebar asks for a repaint");
    });

    void it("unmounts and resets the expansion when the last job ends", () => {
        const reg = new BackgroundRegistry();
        const job = createRunningJob({
            id: "job-1-7",
            command: "npm run build",
            pid: 129,
            logPath: tmpLog("unmount.log", ""),
            toolCallId: "t",
        });
        add(reg, job);
        const h = ctxStub();

        renderSidebar(reg, h.ctx);
        h.component()!.handleMouse!({ type: "click", button: "left" });
        job.status = "completed";
        job.exitCode = 0;
        renderSidebar(reg, h.ctx);

        assert.equal(h.component(), undefined, "no widget without running jobs");
        assert.equal(h.unmounts(), 1, "the component is cleared");
        assert.equal(reg.sidebarMounted, false);
        assert.equal(reg.sidebarExpanded, false, "a new job starts collapsed");
        assert.equal(reg.sidebarTimer, undefined, "no ticker without running jobs");
    });

    void it("falls back to the command when there is no output yet", () => {
        const reg = new BackgroundRegistry();
        add(reg, createRunningJob({
            id: "job-1-8",
            command: "npm run build",
            pid: 130,
            logPath: tmpLog("empty-job.log", ""),
            toolCallId: "t",
        }));

        const h = ctxStub();
        renderSidebar(reg, h.ctx);
        assert.match(plain(h.lines()[0]), /npm run build/);
    });

    void it("renders no widget for terminal jobs", () => {
        const reg = new BackgroundRegistry();
        const job = createRunningJob({
            id: "job-1-9",
            command: "npm test",
            pid: 131,
            logPath: tmpLog("done-job.log", "done\n"),
            toolCallId: "t",
        });
        add(reg, job);
        job.status = "completed";
        job.exitCode = 0;

        const h = ctxStub();
        renderSidebar(reg, h.ctx);
        assert.equal(h.component(), undefined, "no pills — a terminal job's outcome is always surfaced elsewhere");
        assert.equal(reg.sidebarTimer, undefined, "no ticker without running jobs");
    });

    void it("hides terminal jobs once notified", () => {
        const reg = new BackgroundRegistry();
        const job = createRunningJob({
            id: "job-1-10",
            command: "npm test",
            pid: 132,
            logPath: tmpLog("notified-job.log", "done\n"),
            toolCallId: "t",
        });
        add(reg, job);
        job.status = "killed";
        job.notified = true;

        const h = ctxStub();
        renderSidebar(reg, h.ctx);
        assert.equal(h.component(), undefined, "no pills at all — widget cleared");
    });

    void it("falls back to string lines on hosts without component widgets", () => {
        const reg = new BackgroundRegistry();
        add(reg, createRunningJob({
            id: "job-1-11",
            command: LONG_COMMAND,
            pid: 133,
            logPath: tmpLog("rpc.log", '{"step":"ok"}\n'),
            toolCallId: "t",
        }));

        let widget: string[] | undefined;
        const ctx = {
            mode: "rpc",
            ui: {
                notify() {},
                setWidget: (_n: string, content: unknown) => {
                    if (Array.isArray(content)) widget = content as string[];
                },
                setStatus() {},
                theme: { fg: (_c: string, t: string) => t },
            },
        } as unknown as UiContext;

        renderSidebar(reg, ctx);
        const lines = widget ?? [];
        assert.ok(lines[0]?.includes(LONG_COMMAND), "the host receives the whole command and wraps it");
        assert.ok(lines[0]?.includes('↳ {"step":"ok"}'), "the progress row rides along in string form");
        assert.equal(reg.sidebarTui, undefined, "no component handle in string mode");
    });
});

process.on("exit", () => {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
});
