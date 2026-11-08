/**
 * log-window: the byte-window reader behind /bg-log. Covers line-boundary
 * alignment, the unterminated `pending` line, appending, loading older output,
 * and resync after truncation.
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    atWindowLimit,
    extendBackward,
    extendForward,
    olderBytes,
    tailWindow,
} from "../log-window.ts";

const dir = join(tmpdir(), `pi-bg-log-window-${process.pid}`);
const log = join(dir, "job.log");

function write(text: string): void {
    writeFileSync(log, text);
}

void describe("log-window", () => {
    beforeEach(() => {
        mkdirSync(dir, { recursive: true });
        rmSync(log, { force: true });
    });

    void it("returns an empty window for a missing or empty log", () => {
        const missing = tailWindow(log);
        assert.deepEqual(missing, { start: 0, end: 0, lines: [], pending: "" });

        write("");
        assert.deepEqual(tailWindow(log), { start: 0, end: 0, lines: [], pending: "" });
    });

    void it("shows whole lines and keeps an unterminated line pending", () => {
        write("one\ntwo\nthree");

        const win = tailWindow(log);
        assert.deepEqual(win.lines, ["one", "two"]);
        assert.equal(win.pending, "three");
        assert.equal(win.start, 0);
        assert.equal(win.end, Buffer.byteLength("one\ntwo\n"));
    });

    void it("aligns a bounded tail to a line boundary", () => {
        write("aaaa\nbbbb\ncccc\ndddd\n");

        const win = tailWindow(log, 10);
        // Byte 18 is inside "cccc"; the window starts at "dddd".
        assert.deepEqual(win.lines, ["dddd"]);
        assert.equal(win.start, Buffer.byteLength("aaaa\nbbbb\ncccc\n"));
        assert.equal(olderBytes(win), Buffer.byteLength("aaaa\nbbbb\ncccc\n"));
        assert.equal(win.pending, "");
    });

    void it("appends only newly completed lines", () => {
        write("one\n");
        const first = tailWindow(log);

        appendFileSync(log, "two\nthree");
        const grown = extendForward(log, first);
        assert.ok(grown);
        assert.deepEqual(grown.lines, ["one", "two"]);
        assert.equal(grown.pending, "three");
        assert.equal(grown.start, first.start);

        // Nothing new since the last read.
        assert.equal(extendForward(log, grown), undefined);
    });

    void it("reports growth of the pending line without committing it", () => {
        write("one\ntw");
        const first = tailWindow(log);

        appendFileSync(log, "o");
        const grown = extendForward(log, first);
        assert.ok(grown);
        assert.deepEqual(grown.lines, ["one"]);
        assert.equal(grown.pending, "two");
    });

    void it("prepends older output and stops at the file start", () => {
        write("aaaa\nbbbb\ncccc\ndddd\n");
        const tail = tailWindow(log, 10);
        assert.deepEqual(tail.lines, ["dddd"]);

        const older = extendBackward(log, tail, 10);
        assert.ok(older);
        // 10 bytes reach back into the middle of "bbbb"; the fragment is dropped.
        assert.deepEqual(older.lines, ["cccc", "dddd"]);
        assert.equal(older.end, tail.end);

        const oldest = extendBackward(log, older, 10);
        assert.ok(oldest);
        assert.deepEqual(oldest.lines, ["aaaa", "bbbb", "cccc", "dddd"]);
        assert.equal(oldest.start, 0);
        assert.equal(extendBackward(log, oldest, 10), undefined);
    });

    void it("resyncs the tail when the log shrinks", () => {
        write("one\ntwo\n");
        const win = tailWindow(log);

        write("fresh\n");
        const resynced = extendForward(log, win);
        assert.ok(resynced);
        assert.deepEqual(resynced.lines, ["fresh"]);
        assert.equal(resynced.start, 0);
    });

    void it("flags a full window", () => {
        write("one\n");
        const win = tailWindow(log);
        assert.equal(atWindowLimit(win), false);
        const full = { ...win, start: win.end - 1024 * 1024 };
        assert.equal(atWindowLimit(full), true);
    });
});
