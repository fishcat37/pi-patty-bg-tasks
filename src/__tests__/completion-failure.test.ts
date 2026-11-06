import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { BackgroundRegistry } from "../state.ts";
import { add, createRunningJob, stopSidebarTicker } from "../registry.ts";
import { abortJob, startBackgroundJob } from "../lifecycle.ts";
import { startMonitorSession } from "../monitor-session.ts";
import { spawnCommandSource } from "../monitor-source.ts";
import { killProcessTree } from "../spawn.ts";
import { EVENT, type UiContext } from "../types.ts";

const ctx: UiContext = {
    ui: {
        notify() {},
        setWidget() {},
        setStatus() {},
        theme: { fg: (_color, text) => text },
        select: async () => undefined,
        editor: async () => undefined,
    },
};

describe("real command completion when observers fail", () => {
    for (const code of [0, 7]) {
        it(`records exit ${code} and notifies even when monitor event delivery throws`, async () => {
            const dir = mkdtempSync(join(tmpdir(), "patty-completion-"));
            const reg = new BackgroundRegistry();
            const source = spawnCommandSource({
                command: `printf 'business result\\n'; exit ${code}`,
                cwd: dir,
                logPath: join(dir, "output.log"),
                errPath: join(dir, "output.err"),
            });
            const job = createRunningJob({
                id: "monitor-delivery-failure", command: source.label,
                pid: source.pid, logPath: source.logPath,
                toolCallId: "test", kind: "monitor",
            });
            add(reg, job);
            const messages: Array<{ customType: string; content: string }> = [];
            const pi = {
                sendMessage(message: { customType: string; content: string }) {
                    if (message.customType === EVENT.monitorEvent) {
                        throw new Error("session rejected event delivery");
                    }
                    messages.push(message);
                },
            };
            // spawn is unref'ed in production; the Pi host keeps its loop alive.
            const host = setInterval(() => {}, 1000);
            try {
                startMonitorSession({
                    pi: pi as never, reg, ctx, job, source,
                    description: "command result", persistent: false, timeoutMs: 3000,
                });
                const done = job.donePromise;
                await source.exit;
                await Promise.race([
                    done,
                    delay(1000).then(() => {
                        throw new Error("exited monitor remained running");
                    }),
                ]);
                const expected = code === 0 ? "completed" : "failed";
                assert.equal(job.status, expected);
                assert.equal(job.exitCode, code);
                assert.equal(reg.jobAborts.has(job.id), false);
                assert.equal(reg.jobs.has(job.id), false);
                assert.match(readFileSync(source.logPath, "utf8"), /business result/);
                assert.equal(messages.length, 1);
                assert.match(messages[0].content, new RegExp(`<status>${expected}</status>`));
            } finally {
                clearInterval(host);
                abortJob(reg, job.id);
                stopSidebarTicker(reg);
                killProcessTree(source.pid, "SIGKILL");
                rmSync(dir, { recursive: true, force: true });
            }
        });
    }

    it("still completes a real command when its exit callback throws", async () => {
        const dir = mkdtempSync(join(tmpdir(), "patty-exit-callback-"));
        const reg = new BackgroundRegistry();
        const source = spawnCommandSource({
            command: "exit 7", cwd: dir,
            logPath: join(dir, "output.log"), errPath: join(dir, "output.err"),
        });
        const job = createRunningJob({
            id: "exit-callback-failure", command: source.label,
            pid: source.pid, logPath: source.logPath, toolCallId: "test",
        });
        add(reg, job);
        const host = setInterval(() => {}, 1000);
        try {
            startBackgroundJob({
                pi: { sendMessage() {} } as never, reg, ctx, job, exit: source.exit,
                onExit() { throw new Error("observer failed after process exit"); },
            });
            await source.exit;
            await Promise.race([
                job.donePromise,
                delay(1000).then(() => { throw new Error("exited command remained running"); }),
            ]);
            assert.equal(job.status, "failed");
            assert.equal(job.exitCode, 7);
            assert.equal(reg.jobAborts.has(job.id), false);
        } finally {
            clearInterval(host);
            abortJob(reg, job.id);
            stopSidebarTicker(reg);
            killProcessTree(source.pid, "SIGKILL");
            rmSync(dir, { recursive: true, force: true });
        }
    });
});
