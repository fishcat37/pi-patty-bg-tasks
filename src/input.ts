// src/input.ts
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { BackgroundRegistry } from "./state.ts";
import type { UiContext } from "./types.ts";
import { backgroundActiveForeground } from "./lifecycle.ts";

export function registerInputHandlers(pi: ExtensionAPI, reg: BackgroundRegistry): void {
    pi.on("input", async (event, ctx) => {
        // Cooperative steering (Claude Code parity): ANY input typed while a
        // foreground bash command is running moves that command to the
        // background, so the agent stops waiting on it and the message is
        // delivered as the next thing the model sees.
        //
        // The pause request alone is enough to end the wait: the bash tool
        // races its process against that pause, so it returns its
        // "backgrounded" result immediately. We then let Pi queue the message
        // normally (steer, or followUp) — Pi injects a steering message right
        // after the tool results, before the next model call.
        //
        // We deliberately do NOT call ctx.abort(). In Pi an abort rejects the
        // running turn with an AbortError, which lands in the transcript as
        // "Error: This operation was aborted", drops the message back into the
        // editor, and loses attached images. See lifecycle.takeControl, which
        // avoids abort for the same reason.
        if (reg.foreground.size === 0) return { action: "continue" };
        // Don't intercept extension-sourced messages.
        if (event.source === "extension") return { action: "continue" };

        backgroundActiveForeground(reg, ctx as UiContext);
        return { action: "continue" };
    });
}
