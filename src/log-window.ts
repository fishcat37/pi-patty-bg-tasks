/**
 * Byte-window reader for the /bg-log viewer.
 *
 * A background job's log can be up to MAX_LOG_BYTES (100 MiB); the viewer never
 * loads all of it. Instead it keeps a window `[start, end)` of *complete* lines
 * and grows it in three directions on demand:
 *
 *   - tailWindow:     the last N bytes, starting at a line boundary
 *   - extendBackward: one page of older output, prepended
 *   - extendForward:  newly written lines, appended (start stays put, so a
 *                     reader scrolled into history doesn't get shifted)
 *
 * `end` always points just past the last newline we consumed, and the bytes
 * after it live in `pending` — the line the child process is still writing.
 * Cutting only at newlines means a multi-byte UTF-8 character is never split
 * across two reads.
 */

import { closeSync, openSync, readSync, statSync } from "node:fs";

/** Bytes loaded on open, and per "load older" press. */
export const LOG_VIEW_PAGE_BYTES = 64 * 1024;
/** Hard cap on one window's size — a scrolling reader, not a file slurp. */
export const LOG_VIEW_MAX_BYTES = 1024 * 1024;

const NEWLINE = 0x0a;

export interface LogWindow {
    /** Byte offset of the first displayed line. */
    start: number;
    /** Byte offset just past the last displayed line (where `pending` starts). */
    end: number;
    /** Complete lines in [start, end). */
    lines: string[];
    /** Bytes after `end` that contain no newline yet — not committed. */
    pending: string;
}

const EMPTY: LogWindow = { start: 0, end: 0, lines: [], pending: "" };

/**
 * The last `bytes` bytes of the log, aligned to a line boundary. Returns an
 * empty window when the file doesn't exist (yet) or has no output.
 */
export function tailWindow(
    logPath: string,
    bytes: number = LOG_VIEW_PAGE_BYTES
): LogWindow {
    const size = fileSize(logPath);
    if (size === 0) return { ...EMPTY };
    return loadFrom(logPath, Math.max(0, size - bytes), size);
}

/**
 * Prepend one page of older output. Returns undefined when the window already
 * reaches the start of the file or when it is at its size limit.
 */
export function extendBackward(
    logPath: string,
    win: LogWindow,
    bytes: number = LOG_VIEW_PAGE_BYTES
): LogWindow | undefined {
    const room = LOG_VIEW_MAX_BYTES - (win.end - win.start);
    if (win.start === 0 || room <= 0) return undefined;

    const want = Math.min(bytes, room, win.start);
    const rawStart = win.start - want;
    const buf = readBytes(logPath, rawStart, win.start);
    if (!buf) return undefined;

    // rawStart is inside a line unless the window reaches the file start, so
    // drop the leading fragment; the tail needs no fixup because win.start is
    // itself a line boundary.
    const skip = skipLeadingFragment(buf, rawStart);
    return {
        start: rawStart + skip,
        end: win.end,
        lines: [...splitLines(buf.subarray(skip)), ...win.lines],
        pending: win.pending,
    };
}

/**
 * Read whatever was appended since `win.end`. Returns undefined when nothing
 * changed, so the viewer can skip a redraw. A shrunken file (rotation or
 * truncation) resyncs to a fresh tail window instead of going silent.
 */
export function extendForward(
    logPath: string,
    win: LogWindow,
    bytes: number = LOG_VIEW_PAGE_BYTES
): LogWindow | undefined {
    const size = fileSize(logPath);
    if (size < win.end) return tailWindow(logPath, bytes);
    if (size === win.end) return undefined;

    const buf = readBytes(logPath, win.end, size);
    if (!buf) return undefined;

    const lastNewline = buf.lastIndexOf(NEWLINE);
    if (lastNewline < 0) {
        // Only the unterminated line grew — keep offset/lines, refresh pending.
        const pending = buf.toString("utf-8");
        return pending === win.pending ? undefined : { ...win, pending };
    }

    const committed = buf.subarray(0, lastNewline + 1);
    return {
        start: win.start,
        end: win.end + committed.length,
        lines: [...win.lines, ...splitLines(committed)],
        pending: buf.subarray(lastNewline + 1).toString("utf-8"),
    };
}

/** Bytes of output that exist before the window starts (the "load older" cue). */
export function olderBytes(win: LogWindow): number {
    return win.start;
}

/** True when one more page would not fit under LOG_VIEW_MAX_BYTES. */
export function atWindowLimit(win: LogWindow): boolean {
    return win.end - win.start >= LOG_VIEW_MAX_BYTES;
}

// ─── internals ───────────────────────────────────────────────────────────

/** Read [start, size) and commit only the newline-terminated part. */
function loadFrom(logPath: string, rawStart: number, size: number): LogWindow {
    const buf = readBytes(logPath, rawStart, size);
    if (!buf) return { ...EMPTY };

    const skip = skipLeadingFragment(buf, rawStart);
    const body = buf.subarray(skip);
    const lastNewline = body.lastIndexOf(NEWLINE);
    const committed = lastNewline < 0 ? body.subarray(0, 0) : body.subarray(0, lastNewline + 1);

    return {
        start: rawStart + skip,
        end: rawStart + skip + committed.length,
        lines: splitLines(committed),
        pending: body.subarray(committed.length).toString("utf-8"),
    };
}

/** Bytes to skip before the first whole line when the read starts mid-line. */
function skipLeadingFragment(buf: Buffer, rawStart: number): number {
    if (rawStart === 0) return 0;
    const nl = buf.indexOf(NEWLINE);
    return nl < 0 ? buf.length : nl + 1;
}

/** Split a newline-terminated buffer into lines (no trailing empty element). */
function splitLines(buf: Buffer): string[] {
    if (buf.length === 0) return [];
    return buf.toString("utf-8").split("\n").slice(0, -1);
}

function readBytes(logPath: string, start: number, end: number): Buffer | undefined {
    if (end <= start) return undefined;
    let fd: number;
    try {
        fd = openSync(logPath, "r");
    } catch {
        return undefined;
    }
    try {
        const buf = Buffer.alloc(end - start);
        let read = 0;
        while (read < buf.length) {
            const n = readSync(fd, buf, read, buf.length - read, start + read);
            if (n <= 0) break;
            read += n;
        }
        return read === buf.length ? buf : buf.subarray(0, read);
    } catch {
        return undefined;
    } finally {
        closeSync(fd);
    }
}

function fileSize(logPath: string): number {
    try {
        return statSync(logPath).size;
    } catch {
        return 0;
    }
}
