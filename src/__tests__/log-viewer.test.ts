/**
 * LogViewer: the /bg-log component — header contents, follow-while-running,
 * scroll/follow interplay, loading older output, and closing.
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { LogViewer, bodyRows } from "../log-viewer.ts";
import { createRunningJob, errPathFor, LOG_DIR } from "../registry.ts";
import type { Job } from "../types.ts";

const dir = join(tmpdir(), `pi-bg-log-viewer-${process.pid}`);
const logPath = join(dir, "b1.log");

const NO_COLOUR = { fg: (_colour: string, text: string) => text };

function makeJob(over: Partial<Job> = {}): Job {
    const job = createRunningJob({
        id: "b1",
        command: "npm run build",
        pid: 4242,
        logPath,
        toolCallId: "call-1",
        name: "build",
    });
    return Object.assign(job, over);
}

function makeViewer(job: Job, over: { pollMs?: number; onClose?: () => void } = {}) {
    const renders: number[] = [];
    const viewer = new LogViewer({
        job,
        tui: { requestRender: () => renders.push(1) },
        theme: NO_COLOUR,
        rows: () => 30,
        pollMs: over.pollMs ?? 0,
        onClose: over.onClose ?? (() => {}),
    });
    return { viewer, renders };
}

/** Rendered body rows (everything between the two header lines and the footer). */
function body(viewer: LogViewer, width = 80): string[] {
    return viewer.render(width).slice(2, -1);
}

void describe("LogViewer", () => {
    beforeEach(() => {
        mkdirSync(dir, { recursive: true });
        writeFileSync(logPath, "line one\nline two\n");
    });

    void it("renders the job header, its log lines and the key hints", () => {
        const { viewer } = makeViewer(makeJob());
        const lines = viewer.render(80);

        assert.match(lines[0], /▶ build \(b1\)/);
        assert.match(lines[1], /\/tmp\/pi-bg-log-viewer-\d+\/b1\.log/);
        assert.deepEqual(body(viewer).slice(0, 2), ["line one", "line two"]);
        assert.match(lines.at(-1)!, /f follow:on/);
        viewer.dispose();
    });

    void it("shows the exit code once the job is done", () => {
        const { viewer } = makeViewer(makeJob({ status: "failed", exitCode: 2 }));
        const header = viewer.render(80)[0];
        assert.match(header, /✗/);
        assert.match(header, /failed · exit 2/);
        viewer.dispose();
    });

    void it("follows new output while the job runs", async () => {
        const { viewer, renders } = makeViewer(makeJob(), { pollMs: 20 });
        viewer.start();
        appendFileSync(logPath, "line three\n");

        await delay(120);
        assert.ok(renders.length > 0, "polling should request a render");
        assert.deepEqual(body(viewer).slice(0, 3), ["line one", "line two", "line three"]);
        viewer.dispose();
    });

    void it("stops following when scrolled up, resumes at the bottom", () => {
        writeFileSync(logPath, Array.from({ length: 60 }, (_, i) => `line ${i + 1}`).join("\n") + "\n");
        const { viewer } = makeViewer(makeJob());
        viewer.render(80);
        const height = bodyRows(30);
        assert.equal(body(viewer).at(-1), "line 60");

        viewer.handleInput("\x1b[A"); // up
        assert.match(viewer.render(80).at(-1)!, /f follow:off/);
        assert.notEqual(body(viewer).at(-1), "line 60");
        assert.equal(body(viewer)[0], `line ${60 - height}`);

        viewer.handleInput("G"); // jump back to the bottom
        assert.equal(body(viewer).at(-1), "line 60");
        assert.match(viewer.render(80).at(-1)!, /f follow:on/);

        viewer.handleInput("\x15"); // ctrl+u pages up (PgUp is often swallowed)
        assert.equal(body(viewer)[0], `line ${60 - 2 * height + 1}`);
        assert.match(viewer.render(80).at(-1)!, /f follow:off/);
        viewer.dispose();
    });

    void it("loads older output from a log bigger than one page", () => {
        const long = Array.from({ length: 2_000 }, (_, i) => `${String(i).padStart(4, "0")} ${"x".repeat(90)}`);
        writeFileSync(logPath, long.join("\n") + "\n");

        const { viewer } = makeViewer(makeJob());
        const firstWindow = viewer.render(80);
        assert.match(firstWindow[1], /older/);
        assert.match(firstWindow.at(-1)!, /g older/);
        assert.match(body(viewer).at(-1)!, /^1999 x+/);

        viewer.handleInput("\x1b[H"); // home: top of the current window
        const topBefore = Number(body(viewer)[0].slice(0, 4));
        assert.ok(topBefore > 0, "the first page does not start at line 0");

        viewer.handleInput("g");
        viewer.handleInput("\x1b[H");
        const topAfter = Number(body(viewer)[0].slice(0, 4));
        assert.ok(topAfter < topBefore, "loading older output reached further back");

        // Loading repeatedly reaches the start of the file and drops the hint.
        for (let i = 0; i < 50; i++) viewer.handleInput("g");
        const full = viewer.render(80);
        assert.equal(full[1].includes("older"), false);
        assert.doesNotMatch(full.at(-1)!, /g older/);
        viewer.handleInput("\x1b[H");
        assert.match(body(viewer)[0], /^0000 /);
        viewer.dispose();
    });

    void it("flips to a monitor's captured stderr with e", () => {
        mkdirSync(LOG_DIR, { recursive: true });
        const id = `mstderr${process.pid}`;
        const errPath = errPathFor(id);
        writeFileSync(logPath, "event: port 4000 up\n");
        writeFileSync(errPath, "stderr: connection refused\n");

        const { viewer } = makeViewer(makeJob({ id, kind: "monitor" }));
        try {
            assert.match(viewer.render(80)[1], /^Log: /);
            assert.match(viewer.render(80).at(-1)!, /e stderr/);
            assert.deepEqual(body(viewer)[0], "event: port 4000 up");

            viewer.handleInput("e");
            const stderrView = viewer.render(80);
            assert.match(stderrView[1], /^Stderr: /);
            assert.match(stderrView[1], /mstderr\d+\.err/);
            assert.deepEqual(body(viewer)[0], "stderr: connection refused");
            assert.match(stderrView.at(-1)!, /e log/);

            viewer.handleInput("e");
            assert.match(viewer.render(80)[1], /^Log: /);
            assert.deepEqual(body(viewer)[0], "event: port 4000 up");
        } finally {
            viewer.dispose();
            rmSync(errPath, { force: true });
        }
    });

    void it("keeps following the source that is on screen", async () => {
        mkdirSync(LOG_DIR, { recursive: true });
        const id = `mfresh${process.pid}`;
        const errPath = errPathFor(id);
        writeFileSync(logPath, "stdout\n");
        writeFileSync(errPath, "first stderr line\n");

        const { viewer } = makeViewer(makeJob({ id, kind: "monitor" }), { pollMs: 20 });
        viewer.start();
        try {
            viewer.handleInput("e"); // switch to stderr
            appendFileSync(errPath, "second stderr line\n");
            await delay(120);
            assert.deepEqual(body(viewer).slice(0, 2), ["first stderr line", "second stderr line"]);
        } finally {
            viewer.dispose();
            rmSync(errPath, { force: true });
        }
    });

    void it("ignores e when the job has no captured stderr", () => {
        const { viewer } = makeViewer(makeJob());
        assert.doesNotMatch(viewer.render(80).at(-1)!, /e stderr/);
        viewer.handleInput("e");
        assert.match(viewer.render(80)[1], /^Log: /);
        viewer.dispose();
    });

    void it("says so when there is no output yet", () => {
        writeFileSync(logPath, "");
        const { viewer } = makeViewer(makeJob());
        assert.match(body(viewer)[0], /no output yet/);
        viewer.dispose();
    });

    void it("closes on q or Esc and stops polling", async () => {
        let closed = 0;
        const { viewer, renders } = makeViewer(makeJob(), {
            pollMs: 20,
            onClose: () => closed++,
        });
        viewer.start();

        viewer.handleInput("q");
        viewer.handleInput("\x1b");
        assert.equal(closed, 1);

        const before = renders.length;
        await delay(80);
        assert.equal(renders.length, before, "disposed viewer stops polling");
    });
});
