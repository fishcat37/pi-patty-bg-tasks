/**
 * Slash commands — /bg-version metadata, and /bg-log's two entry points
 * (direct id, or the picker).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BackgroundRegistry } from "../state.ts";
import { registerCommands } from "../commands.ts";
import { add, createRunningJob } from "../registry.ts";

const dir = join(tmpdir(), `pi-bg-commands-${process.pid}`);

type Handler = (args: string, ctx: unknown) => Promise<void>;
type CommandDef = { handler: Handler };

function register(reg: BackgroundRegistry): Map<string, CommandDef> {
    const commands = new Map<string, CommandDef>();
    const pi = {
        registerCommand(name: string, definition: CommandDef) {
            commands.set(name, definition);
        },
        sendMessage() {},
    };
    registerCommands(pi as never, reg);
    return commands;
}

/** A UiContext stand-in whose custom() mounts the component, renders it once
 *  and immediately closes it — the shortest real path through the viewer. */
function fakeUi(selectAnswer?: string) {
    const notices: { message: string; level?: string }[] = [];
    const selections: string[][] = [];
    const rendered: string[] = [];
    const editors: string[] = [];
    // The picker loops until the user cancels: answer once, then Esc.
    let pickerAnswers = 0;

    const ui = {
        notify(message: string, level?: "info" | "warning" | "error") {
            notices.push({ message, level });
        },
        setWidget() {},
        setStatus() {},
        theme: { fg: (_colour: string, text: string) => text },
        async select(_title: string, options: string[]) {
            selections.push(options);
            if (selectAnswer === undefined || pickerAnswers++ > 0) return undefined;
            return options.find((o) => o.includes(selectAnswer));
        },
        async editor(_title: string, content: string) {
            editors.push(content);
            return undefined;
        },
        async custom(
            factory: (
                tui: { requestRender(): void },
                theme: { fg(c: string, t: string): string },
                keybindings: unknown,
                done: (result: unknown) => void
            ) => unknown,
            _options?: { overlay?: boolean }
        ) {
            let closed = false;
            const component = (await factory(
                { requestRender() {} },
                { fg: (_c: string, t: string) => t },
                {},
                () => { closed = true; }
            )) as {
                render(width: number): string[];
                handleInput?(data: string): void;
                dispose?(): void;
            };
            rendered.push(...component.render(80));
            component.handleInput?.("q"); // close the viewer
            component.dispose?.();
            assert.equal(closed, true, "the viewer must resolve ctx.ui.custom");
            return undefined;
        },
    };

    return { ui, notices, selections, rendered, editors };
}

void describe("commands", () => {
    void it("/bg-version reports the loaded package version and path", async () => {
        const commands = register(new BackgroundRegistry());
        const notices: string[] = [];

        await commands.get("bg-version")?.handler("", {
            ui: { notify: (message: string) => notices.push(message) },
        });

        assert.ok(commands.has("bg"));
        assert.ok(commands.has("bg-list"));
        assert.ok(commands.has("bg-log"));
        assert.ok(commands.has("bg-version"));
        assert.match(notices[0], /^pi-patty-bg-tasks@\d+\.\d+\.\d+ loaded from /);
        assert.match(notices[0], /pi-patty-bg-tasks$/);
    });

    void it("/bg-log <id> opens that job's log in the viewer", async () => {
        mkdirSync(dir, { recursive: true });
        const logPath = join(dir, "b7f3k9a2.log");
        writeFileSync(logPath, "compiling module 1\ncompiling module 2\n");

        const reg = new BackgroundRegistry();
        add(reg, createRunningJob({
            id: "b7f3k9a2",
            command: "npm run build",
            pid: 1234,
            logPath,
            toolCallId: "call-1",
            name: "build",
        }));

        const { ui, rendered } = fakeUi();
        await register(reg).get("bg-log")!.handler("b7f3k9a2", { ui });

        assert.match(rendered[0], /▶ build \(b7f3k9a2\)/);
        assert.ok(rendered.includes("compiling module 1"), "log lines are rendered");
        assert.ok(rendered.includes("compiling module 2"));
    });

    void it("/bg-log falls back to a static snapshot outside the TUI", async () => {
        mkdirSync(dir, { recursive: true });
        const logPath = join(dir, "b9.log");
        writeFileSync(logPath, "rpc mode output\n");

        const reg = new BackgroundRegistry();
        add(reg, createRunningJob({
            id: "b9",
            command: "npm run build",
            pid: 99,
            logPath,
            toolCallId: "call-9",
        }));

        const { ui, rendered, editors } = fakeUi();
        // RPC mode stubs ui.custom() out, so the viewer must not be mounted.
        await register(reg).get("bg-log")!.handler("b9", { mode: "rpc", ui });

        assert.equal(rendered.length, 0);
        assert.equal(editors.length, 1);
        assert.match(editors[0], /--- OUTPUT ---/);
        assert.match(editors[0], /rpc mode output/);
    });

    void it("/bg-log with an unknown id reports it instead of opening anything", async () => {
        const { ui, notices, selections, rendered } = fakeUi();
        await register(new BackgroundRegistry()).get("bg-log")!.handler("nope", { ui });

        assert.deepEqual(notices, [{ message: "No task found with ID: nope", level: "error" }]);
        assert.equal(rendered.length, 0);
        assert.equal(selections.length, 0);
    });

    void it("/bg-log without an id picks a job from the list", async () => {
        mkdirSync(dir, { recursive: true });
        const logPath = join(dir, "b2.log");
        writeFileSync(logPath, "picked job output\n");

        const reg = new BackgroundRegistry();
        add(reg, createRunningJob({
            id: "b2",
            command: "npm test",
            pid: 4321,
            logPath,
            toolCallId: "call-2",
            name: "tests",
        }));
        add(reg, createRunningJob({
            id: "b1",
            command: "npm run build",
            pid: 4322,
            logPath: join(dir, "b1.log"),
            toolCallId: "call-3",
        }));

        const { ui, selections, rendered } = fakeUi("tests (b2)");
        await register(reg).get("bg-log")!.handler("", { ui });

        assert.equal(selections.length, 2, "one picker round, then Esc closes the picker");
        // Both jobs are listed; the picker chose "tests (b2)" by name.
        assert.ok(selections[0].some((option) => /tests \(b2\)/.test(option)));
        assert.ok(rendered.includes("picked job output"));
    });
});
