import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { registerInputHandlers } from "../input.ts";
import { BackgroundRegistry } from "../state.ts";
import type { UiContext } from "../types.ts";

interface ResubmittedMessage {
    text: string;
    deliverAs?: string;
}

type InputHandler = (
    event: {
        type: "input";
        text: string;
        images?: { type: "image"; data: string; mimeType: string }[];
        source: "interactive" | "rpc" | "extension";
        streamingBehavior?: "steer" | "followUp";
    },
    ctx: UiContext & {
        abort(): void;
        signal?: AbortSignal;
    }
) => Promise<
    | { action: "continue" }
    | { action: "transform"; text: string }
    | { action: "handled" }
>;

void describe("input steering (cooperative scheduler)", () => {
    void it("backgrounds the foreground command and lets Pi deliver the message", async () => {
        const reg = new BackgroundRegistry();
        const resubmitted: ResubmittedMessage[] = [];
        const notifications: string[] = [];
        let pauseReason: string | undefined;
        let abortCalled = false;
        const handler = registerAndGetHandler(reg, resubmitted);
        reg.foreground.set("tc-steer", {
            requestPause: (reason) => {
                pauseReason = reason;
            },
        });

        const result = await handler(
            {
                type: "input",
                text: "stop and inspect the last failure",
                source: "interactive",
                streamingBehavior: "steer",
            },
            makeCtx(notifications, { abort: () => { abortCalled = true; } })
        );

        // "continue" hands the message back to Pi: it is queued as steering and
        // injected right after the bash tool result, before the next model call.
        assert.equal(result.action, "continue");
        assert.equal(pauseReason, "manual");
        // Never abort the turn — an abort surfaces "Error: This operation was
        // aborted", pushes the message back into the editor, and drops images.
        assert.equal(abortCalled, false);
        // Never resubmit: Pi already holds the exact message (text + images).
        assert.deepEqual(resubmitted, []);
        assert.deepEqual(notifications, ["▶ Backgrounded — continuing."]);
    });

    void it("passes images through untouched instead of resubmitting text only", async () => {
        const reg = new BackgroundRegistry();
        const resubmitted: ResubmittedMessage[] = [];
        const handler = registerAndGetHandler(reg, resubmitted);
        reg.foreground.set("tc-images", { requestPause: () => {} });

        const images = [{ type: "image" as const, data: "AAAA", mimeType: "image/png" }];
        const result = await handler(
            { type: "input", text: "look at this", images, source: "interactive", streamingBehavior: "steer" },
            makeCtx([])
        );

        assert.equal(result.action, "continue");
        assert.deepEqual(resubmitted, []);
    });

    void it("second input finds no foreground slot and changes nothing", async () => {
        const reg = new BackgroundRegistry();
        const resubmitted: ResubmittedMessage[] = [];
        const notifications: string[] = [];
        let pauseCalls = 0;
        const handler = registerAndGetHandler(reg, resubmitted);
        reg.foreground.set("tc-steer2", {
            requestPause: () => {
                pauseCalls++;
            },
        });

        const r1 = await handler(
            { type: "input", text: "first", source: "interactive", streamingBehavior: "steer" },
            makeCtx(notifications)
        );
        const r2 = await handler(
            { type: "input", text: "second", source: "interactive", streamingBehavior: "steer" },
            makeCtx(notifications)
        );

        assert.equal(r1.action, "continue");
        assert.equal(r2.action, "continue");
        // The pause hand-off clears the foreground slot, so the second message
        // only gets queued — no second toast, no second pause request.
        assert.equal(pauseCalls, 1);
        assert.deepEqual(notifications, ["▶ Backgrounded — continuing."]);
        assert.deepEqual(resubmitted, []);
    });

    void it("returns continue when no cooperative foreground task is active", async () => {
        const reg = new BackgroundRegistry();
        const resubmitted: ResubmittedMessage[] = [];
        const handler = registerAndGetHandler(reg, resubmitted);

        const result = await handler(
            { type: "input", text: "any steering", source: "interactive", streamingBehavior: "steer" },
            makeCtx([])
        );

        assert.deepEqual(result, { action: "continue" });
        assert.equal(resubmitted.length, 0);
    });

    void it("ignores extension-sourced input (recursion guard)", async () => {
        const reg = new BackgroundRegistry();
        const resubmitted: ResubmittedMessage[] = [];
        let pauseCalls = 0;
        const handler = registerAndGetHandler(reg, resubmitted);
        reg.foreground.set("tc-ext", {
            requestPause: () => {
                pauseCalls++;
            },
        });

        const result = await handler(
            { type: "input", text: "self-resubmit", source: "extension", streamingBehavior: "steer" },
            makeCtx([])
        );

        assert.deepEqual(result, { action: "continue" });
        assert.equal(pauseCalls, 0);
        assert.equal(resubmitted.length, 0);
    });
});

function registerAndGetHandler(
    reg: BackgroundRegistry,
    resubmitted: ResubmittedMessage[]
): InputHandler {
    let handler: InputHandler | undefined;
    registerInputHandlers(
        {
            on(event: string, fn: InputHandler) {
                if (event === "input") handler = fn;
            },
            sendUserMessage(content: string | object[], options?: { deliverAs?: string }) {
                if (typeof content === "string") {
                    resubmitted.push({ text: content, deliverAs: options?.deliverAs });
                }
            },
        } as never,
        reg
    );
    assert.ok(handler);
    return handler;
}

function makeCtx(
    notifications: string[] = [],
    actions?: { abort(): void }
): UiContext & { abort(): void } {
    return {
        ui: {
            notify: (message) => notifications.push(message),
            setWidget: () => {},
            setStatus: () => {},
            theme: { fg: (_colour, text) => text },
            select: async () => undefined,
            editor: async () => undefined,
        },
        abort: actions?.abort ?? (() => {}),
    };
}
