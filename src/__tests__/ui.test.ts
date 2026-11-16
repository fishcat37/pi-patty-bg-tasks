/**
 * /bg-list panel wiring: the job actions menu must open the same live log
 * viewer as /bg-log (and keep Kill / Remove working).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BackgroundRegistry } from "../state.ts";
import { add, createRunningJob } from "../registry.ts";
import { openBgListPanel } from "../ui.ts";
import type { UiContext } from "../types.ts";

const dir = join(tmpdir(), `pi-bg-ui-${process.pid}`);

/** UiContext stand-in: answers the given selection prompts in order, then Esc;
 *  custom() renders once and closes. */
function harness(answers: string[]) {
    const rendered: string[][] = [];
    const prompts: string[][] = [];
    const titles: string[] = [];
    const notices: string[] = [];
    const queue = [...answers];

    const ui = {
        notify: (message: string) => notices.push(message),
        setWidget() {},
        setStatus() {},
        theme: { fg: (_c: string, t: string) => t },
        async select(title: string, options: string[]) {
            titles.push(title);
            prompts.push(options);
            const answer = queue.shift();
            return answer === undefined ? undefined : options.find((o) => o.includes(answer));
        },
        async editor() {
            return undefined;
        },
        async custom(factory: never) {
            let closed = false;
            const component = (await (factory as unknown as (...a: unknown[]) => unknown)(
                { requestRender() {} },
                { fg: (_c: string, t: string) => t },
                {},
                () => { closed = true; }
            )) as { render(width: number): string[]; handleInput?(d: string): void; dispose?(): void };
            rendered.push(component.render(80));
            component.handleInput?.("q");
            component.dispose?.();
            assert.equal(closed, true);
            return undefined;
        },
    };
    return { ctx: { ui } as unknown as UiContext, rendered, prompts, titles, notices };
}

function seed(reg: BackgroundRegistry, id: string, command = "npm run build"): void {
    mkdirSync(dir, { recursive: true });
    const logPath = join(dir, `${id}.log`);
    writeFileSync(logPath, `output of ${id}\n`);
    add(reg, createRunningJob({
        id,
        command,
        pid: 999,
        logPath,
        toolCallId: `call-${id}`,
        name: id,
    }));
}

void describe("/bg-list panel", () => {
    void it("opens the live log viewer from the job actions menu", async () => {
        const reg = new BackgroundRegistry();
        seed(reg, "b1");
        const { ctx, rendered, prompts } = harness(["b1", "Show Log"]);

        await openBgListPanel(reg, ctx);

        // list → actions → back to the list (Esc there ends the panel).
        assert.equal(prompts.length, 3);
        assert.ok(prompts[1].includes("Show Log"));
        assert.equal(rendered.length, 1);
        assert.match(rendered[0][0], /▶ b1 \(b1\) · running/);
        assert.ok(rendered[0].includes("output of b1"));
    });

    void it("keeps the whole command in the list and the actions header", async () => {
        const reg = new BackgroundRegistry();
        const command =
            "cd /home/wang/code/competition/name-that-llm && uv run python scripts/train/frozen_feature_probe.py --fold 3 --limit 0";
        seed(reg, "b1", command);
        const { ctx, prompts, titles } = harness(["b1"]);

        await openBgListPanel(reg, ctx);

        assert.ok(
            prompts[0].some((option) => option.includes(command)),
            "list line carries the full command for the selector to wrap"
        );
        assert.ok(titles[1].includes(command), "actions header shows it too");
    });

    void it("still kills a running job from the menu", async () => {
        const reg = new BackgroundRegistry();
        seed(reg, "b1");
        const job = reg.jobs.get("b1")!;
        const { ctx, notices } = harness(["b1", "Kill"]);

        await openBgListPanel(reg, ctx);

        assert.equal(job.status, "killed");
        assert.deepEqual(notices, ["Killed b1"]);
    });

    void it("says there is nothing to manage when the registry is empty", async () => {
        const { ctx, notices } = harness([]);
        await openBgListPanel(new BackgroundRegistry(), ctx);
        assert.deepEqual(notices, ["No background tasks"]);
    });
});
