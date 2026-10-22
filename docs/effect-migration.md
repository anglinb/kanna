# Effect migration

Kanna's server (`src/server`) and the parsing in `src/shared` are moving to
[Effect 4](https://effect.website) (`effect@4.0.5`, `@effect/platform-bun`).
The style follows superwall/paywall-next and its `effect-review` skill,
adapted to Effect 4's API and to `bun test`.

The client (`src/client`) stays as it is. The WebSocket protocol, every
snapshot shape, and every file on disk under `~/.kanna` stay byte-for-byte
compatible: this is a refactor, not a behaviour change.

`keybindings.ts` and its test are the worked example. Read them first.

## Foundation (`src/server/effect/`)

| File | What it is |
|---|---|
| `runtime.ts` | `ServerPlatform`: Bun's FileSystem, Path and process services plus the logger. Every service layer is provided with it. |
| `logger.ts` | Keeps the `[kanna] message` console shape for `Effect.log*`. Don't prefix messages with `LOG_PREFIX` yourself. |
| `bridge.ts` | `runKanna` / `runKannaSync` / `subscribeKanna`: how not-yet-migrated Promise code calls a migrated service. Temporary; it is deleted at the end. |
| `testing.ts` | `runTest(effect)`: runs an Effect test body scoped, with `ServerPlatform`. Stands in for `it.effect`/`it.scoped`. |
| `main.ts` | `runKannaMain(program)`: runs a `kanna` process (cli.ts, cli-supervisor.ts). The program's result is the exit code and the process exits when it ends, so Effect timers inside it can't keep a finished process alive. Signals stay with the program. |

`startKannaServer` (`server.ts`) builds one `ManagedRuntime` from the
merged service layers, reads each service out of it, and disposes it at
shutdown. Add your layer to that `Layer.mergeAll(...)`.

## Notes from wave 1

- A layer whose construction needs a value built later in `startKannaServer`
  takes it as a lazy `Effect.sync(() => ...)` or a closure, and only reads it
  after startup (see `ProjectIcons`' `projectPaths`, `UsageLimits`' reads).
- Where a synchronous caller needs a value, keep a synchronous accessor
  (`runKannaSync` over `SubscriptionRef.get`) until the caller migrates;
  don't make it async just to fit.
- `FileSystem.stat` rounds mtimes to whole milliseconds, and
  `readDirectory` returns names only. Where a module persists mtimes or
  must not follow symlinks, keep node's `stat`/`readdir` behind
  `Effect.tryPromise` and say why in a comment.
- Typed fakes live next to the module as `<module>.fake.ts`.

## The provider contract (wave 3)

Provider adapters return `HarnessTurnEffect` (`harness-types.ts`) from an
Effect `startTurn` that runs in a `Scope`: the scope's close is the old
`close()`, `events` is a `Stream`, `interrupt` an Effect. Until agent.ts
migrates (wave 4) it reads them through `toHarnessTurn`
(`harness-bridge.ts`), which turns one back into the Promise `HarnessTurn`.
Callbacks the agent hands an adapter (tool requests, approvals) become
Effect-returning in the adapter's args; agent.ts adapts its Promise
callbacks at the call site with `Effect.tryPromise`.

## Rules

### Services

- A stateful module (a class with `initialize`/`dispose`, listeners, timers,
  watchers, child processes) becomes a service:

  ```ts
  export class Thing extends Context.Service<Thing, {
    readonly snapshot: Effect.Effect<ThingSnapshot>
    readonly changes: Stream.Stream<ThingSnapshot>
    readonly write: (input: ThingInput) => Effect.Effect<ThingSnapshot, ThingWriteError>
  }>()("@kanna/server/Thing") {
    static readonly layer = (options: ThingOptions) => Layer.effect(this, makeThing(options))
  }
  const makeThing = Effect.fn("Thing.make")(function* (options: ThingOptions) { ... })
  ```

  Write the shape out as an explicit type, so that fakes in tests are
  checked against it. Refer to the shape as `Thing["Service"]`.
- `initialize` becomes the layer's construction; `dispose` becomes
  finalizers. Use `Effect.acquireRelease` for resources and
  `Effect.addFinalizer` for cleanup. Run background loops with
  `Effect.forkScoped`. Intervals become
  `Effect.repeat(Schedule.spaced(...))` or `Schedule.fixed`. A layer
  that starts a watcher or listener waits until it is live before it
  returns (see the `Latch` in keybindings).
- `onChange(listener) => unsubscribe` becomes a `Stream`, built from a
  `SubscriptionRef` (snapshot + changes) or a `PubSub` (events). If the old
  API never replayed the current value, drop it (`Stream.drop(1)`) and say so
  in the doc comment.
- Wire dependencies with layers (`Layer.provide`/`Layer.provideMerge`), not
  `Effect.provide` at call sites. The bridge and tests are the exceptions.
- Stateless modules of functions stay modules of functions. The ones that
  do IO become `Effect.fn("Module.name")(function* (...) {...})`. Pure helpers
  (string munging, normalizers, reducers) can stay plain TypeScript. Don't
  rewrite working pure code just to use Effect.

### Effects

- No `async`/`await`, `.then`, `new Promise`, or `try`/`catch` in migrated
  code. Wrap Promise APIs once, at the edge:
  `Effect.tryPromise({ try: (signal) => ..., catch: (cause) => new XError({ ..., cause }) })`.
  Wrap throwing sync APIs with `Effect.try`. Pass the `signal` through when the
  API takes one, so interruption cancels the work.
- Files go through `FileSystem.FileSystem`. Match "not found" with
  `Effect.catchReason("PlatformError", "NotFound", ...)`.
- Subprocesses: if a module spawns with `Bun.spawn`, wrap the spawn in
  `Effect.acquireRelease` (kill on release), and read output with
  `Effect.tryPromise`. Use `ChildProcess` from `effect/unstable/process`
  only where it fits without changing behaviour.
- Loops that run an effect use `Effect.forEach` (with `concurrency` when the
  old code ran in parallel, e.g. `Promise.all`).
- Use `Match` for `switch` over unions in Effect code, with
  `Match.exhaustive` where the union is closed. Prefer `Option` for absence
  inside service internals. Snapshot and wire types keep their `null`s,
  because the client reads them.
- Decode external input (JSON files, CLI or provider output, HTTP bodies,
  WebSocket frames) with `Schema`. Use
  `Schema.decodeUnknownEffect(Schema.fromJsonString(X))` instead of
  `JSON.parse(...) as X`. Don't add `as` casts on untrusted data.

### Errors

- Use `Schema.TaggedError<Self>()("@kanna/server/<module>/<Name>", { ...context, cause: Schema.Defect() })`.
  Include the ids and paths needed to debug the failure without reading
  other logs (chatId, projectId, filePath, command). Never include
  secrets or tokens.
- Handle errors with `catchTag`/`catchTags`/`catchReason`. Don't use
  `catchAll` or `mapError` to flatten error types into one.
- A failure the old code logged and swallowed becomes
  `Effect.tapError(Effect.logWarning(...))` + `Effect.ignore`, or a
  `catchTag` that logs. Keep the same message text.
- Defects (bugs) stay defects. Don't catch them to keep going unless the
  old code did.

### Observability

- Every named function that returns an Effect is
  `Effect.fn("Module.method")`. Annotate the span with ids
  (`Effect.annotateCurrentSpan("chatId", chatId)`). Never annotate PII,
  secrets, file contents or prompt text.
- Use `Effect.logInfo`/`logWarning`/`logError`/`logDebug`, never
  `console.*`, in migrated code. Attach context with
  `Effect.annotateLogs`.

### Tests (`bun test`)

- Keep each test's intent. Run Effect bodies with `runTest(...)` from
  `effect/testing.ts`. Provide the service under test with its real
  layer, or a hand-written fake typed as `Thing["Service"]` (see
  `keybindings.fake.ts`). Tests that hand a fake to the router use the
  same typed fakes, not `as never` objects.
- Test failures with `Effect.result(...)` + `Result.isFailure`, and check
  the `_tag`.
- Add tests for new behaviour you introduce (e.g. a layer now waiting for
  a watcher) and for error paths the old tests didn't reach.

### Not changing (for now)

- `src/shared/cloud-api.ts` is a wire contract mirrored verbatim in
  kanna-site. It stays as plain types.
- `src/shared/types.ts` stays plain types; the client imports them.
  Branded ids (ChatId, ProjectId, …) are a later phase, because they ripple
  into the client.
- `@effect/vitest` is not adopted; `bun test` stays.

## Status

| Area | Modules | State |
|---|---|---|
| Foundation | effect/*, keybindings | done |
| Process & paths | process-utils, paths, editor-detection, terminal-detection, external-open, machine-name, mac-app, restart, instance, instance-socket, project-quick-actions | done |
| Settings | app-settings, llm-provider, provider-catalog, usage-limits, analytics, attribution | done |
| Storage leaves | events, transcript, transcript-media, transcript-payloads, transcript-slim, performance-log, ticket-store, schedules, uploads, standalone-export | done |
| Terminals & serving | terminal-manager, local-http-servers, port-tunnels, share, auth, transcribe, png-thumbnail, project-icons | done |
| Cloud | cloud/*, discovery, background-tasks | done |
| Harness helpers & shared | harness-skills, skills, harness-instructions, visualization-*, handoff, agent-to-agent, session-artifacts, async-queue; Schema for `shared/protocol.ts` client envelopes and `shared/tools.ts` parsing | done |
| Event store | event-store, read-models, transcript-payloads (sync readers) | done |
| Git | diff-store, github, github-branch-pr, github-checks | done |
| Derived state | worktree-probe, worktree-snapshot, ticket-board, ticket-messages, touched-file-backfill, visualization-heights | done |
| Provider plumbing | provider-auth, claude-executable, quick-response, generate-commit-message, generate-title | done |
| CLI | cli-runtime, cli, cli-supervisor, nightly, update-manager, share (CLI output), process-utils (`resolveCommandPath`) | done |
| Codex | codex-app-server, codex-app-server-protocol | wave 3 |
| CLI providers | grok-cli, cursor-cli, cursor-kanna-tools, async-queue | wave 3 |
| Pi & Kanna tools | pi-agent, kanna-tools, kanna-display-tools, kanna-image-tools, kanna-visualization-tool, kanna-tool-adapters, kanna-mcp | wave 3 |
| Orchestration | orchestrator, kanna-orchestration-tools, chat-commands, schedules wiring | wave 3 |
| Composition | agent, ws-router, server, entry, chat-window-route, resume-turns; wire `protocol-schema.ts` into the router; delete `bridge.ts` | wave 4 |
