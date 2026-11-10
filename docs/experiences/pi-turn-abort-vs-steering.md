# Interrupting a running tool: pause hand-off, not `ctx.abort()`

Findings from fixing cooperative steering in `src/input.ts` (2.1.1). The old
code aborted the turn to get the `bash` tool to return; that produced a visible
error, stranded the user's message and dropped attached images. This is worth
keeping because the wrong path looks plausible and the right one looks
redundant.

## Symptoms (observed before the fix)

Typing a message while a foreground command was running produced, in order:

- the bash tool result `Command was manually backgrounded by user with ID: …`,
- the toast `▶ Backgrounded — continuing.`,
- `Error: This operation was aborted`,
- the typed message still sitting in the queue as `Follow-up: …`.

Reproduced through pi's RPC mode (`--mode rpc`): a prompt runs a long
foreground command, and 4 s later a second `prompt` is sent with
`streamingBehavior: "steer"`. The recorded events contained an assistant
message with `stopReason: "aborted"` and `errorMessage: "This operation was
aborted"`, a `queue_update` with the message in `followUp`, and no user message
in the transcript — the run settled with the message never delivered.

## Why `ctx.abort()` breaks this

- In the TUI, the extension `abort()` binding is the Esc handler:
  `restoreQueuedMessagesToEditor({ abort: true })` — it clears all queues, puts
  their text back into the editor, and then calls `agent.abort()`.
- The run's promise rejects. The failure path emits an assistant message with
  `stopReason: "aborted"` and `errorMessage` taken from the thrown error, which
  is Node's `AbortError`: "This operation was aborted". The transcript renderer
  prints that string because it only substitutes a friendlier "Operation
  aborted" for the literal `"Request was aborted"`.
- After an abort-requested run, post-run handling returns `false` instead of
  continuing on queued messages, so any message queued during the abort is not
  drained.

Also relevant: resubmitting through `pi.sendUserMessage(text)` passes only the
text — attached images are lost, and the message is re-delivered as a follow-up
rather than steering.

## What does make a tool return

Nothing needs aborting. Our own foreground hand-off already races the process
exit against a pause promise (`src/tools/bash.ts`), so a pause request resolves
that race and the tool returns its "backgrounded" result immediately.

## Correct pattern

1. Ask the foreground slot to pause (`backgroundActiveForeground`).
2. Return `{ action: "continue" }` from the `input` handler, so pi queues the
   message itself — text and images as received, as `steer` or `followUp`
   depending on `streamingBehavior`.

Pi injects a steering message right after the current turn's tool results and
before the next model call, so the agent stops working on the old task and
answers the new message. The queue display, draining and image handling are
pi's, not ours.

## Keeping Esc working

The bash tool registers its turn-abort handler so a genuine cancel still kills
the process, while a pause that was already requested (steering, Ctrl+Shift+B,
auto-background) leaves it running:

```ts
const onTurnAbort = () => {
    if (!pauseRequested) killProcessTree(spawned.pid, "SIGTERM");
};
```

## Scope note

The RPC `steer` command calls the session's steering queue directly and never
reaches `input` extension handlers. Only `prompt` (with `streamingBehavior`)
goes through them — that is also what the TUI uses when you submit while
streaming, which is the path this extension intercepts.
