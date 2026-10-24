# React → Foldkit migration

The web client (`src/client`, React 19) is being ported to
[Foldkit](https://foldkit.dev) in `src/foldkit`, following the approach in
[Maple's React to Foldkit write-up](https://maple.dev/blog/react-to-foldkit/):
build the parity harness first, decide what "done" means before porting,
and keep agents away from the yardstick.

## Done

A slice (a screen, dialog or flow) is done when, for every scenario that
covers it, in every variant (desktop/mobile × dark/light):

1. pixels are identical, or within that scenario's declared tolerance;
2. painted elements match: same text, box (±1px) and computed styles,
   including the ones a screenshot can't show (cursor, outline, weight);
3. the accessibility tree is identical;
4. the ClientCommand log is identical, in order (subscriptions as a set);
5. no console errors and no command the fixture backend can't handle;
6. its Story and Scene tests pass under `bun test`.

The migration is done when every scenario passes, React is deleted, and the
scenarios stay behind as the visual regression suite.

## Rules

- The reference is the React client, live, not stored screenshots. There
  is no baseline to "update".
- **Port branches touch `src/foldkit/**` only.** The harness is protected:
  `scripts/parity/**`, `src/parity/**`, `src/demo/**`,
  `vite.parity.config.ts`. A branch that changes a scenario, a tolerance or
  the fixture to make a difference go away is rejected. If the harness is
  wrong, that's a separate change, reviewed on its own.
- If React behaves wrongly, the port matches React and the bug is filed,
  not fixed in passing.
- One parity run at a time per machine (the runner takes `.parity/lock`).

## Harness

```
bun run parity                       # every scenario, React vs Foldkit
bun run parity chat-featured         # one scenario
bun run parity:selfcheck             # React vs React must pass, and a
                                     # one-rule CSS change must be caught
```

- `src/parity/fixture.ts` puts the demo's in-browser backend (`src/demo`)
  under both apps, holds its scripted turns on a manual clock
  (`advance(ms)`), and records every frame on `window.__parity`.
- `src/parity/react` is the unchanged React client; `src/parity/foldkit`
  boots `src/foldkit/app`. Each is built by `vite.parity.config.ts`; builds
  are cached on a hash of their inputs.
- `scripts/parity/run.ts` opens each scenario in both, with the clock frozen
  at 2026-06-01T12:00Z, UTC, en-US, waits for socket and DOM to be quiet, and
  compares (`compare.ts`). Output: `.parity/latest/summary.md`, with
  reference, candidate and diff images per capture.
- Scenarios live in `scripts/parity/scenarios/`. Drive them through roles,
  labels and text, so a locator one app lacks is itself a parity failure.

Selfcheck results on the first run (3 scenarios × 4 variants): React vs
React 12/12 identical on every check, in two separate runs. Injecting
`.text-muted-foreground{letter-spacing:.02em}` fails pixels and paint;
injecting `button{cursor:default}` fails paint alone (pixels identical),
which is the class of bug Maple's screenshot-only checks missed.

## Decisions

### 1. Effect 4.0.5 and `bun test`: go

foldkit 0.169 declares `effect` and `@effect/platform-browser` at exactly
4.0.0; the repo runs 4.0.5. Checked:

- Bun installs one copy of `effect` (4.0.5); no nested 4.0.0.
- `tsc` with `skipLibCheck: false` reports nothing in foldkit's declarations.
- Story and Scene are plain functions that throw; only the optional
  `foldkit/test/vitest` matchers need Vitest. Both run under `bun test`
  (`src/foldkit/toolchain.test.ts`, kept as a canary for upgrades).
- A Vite build of a Runtime program boots in headless Chromium, handles
  input and a Command, with no console errors.

Foldkit's strictness carries into tests: a Story can't send the next
Message while a Command is unresolved, so "double submit" is tested from a
model already in flight. That is the behaviour we want the review loop to
check for anyway.

### Still to decide (spikes, in order)

2. **Socket.** `KannaSocket` (`src/client/app/socket.ts`) as a
   ManagedResource + Subscription: snapshots in as Messages, ClientCommands
   out as Commands, reconnect and the optimistic-prompt reconciliation.
3. **Overlays.** Replacements for Radix dialog, popover, hover card,
   select, tooltip and context menu, and cmdk; check `@foldkit/ui`. The
   result is the template every porting agent copies.
4. **Transcript.** `ChatTranscriptViewport`: windowing, `chat.loadOlder`,
   streaming, stick-to-bottom, under the parity runner's timing.
5. **Imperative widgets.** xterm and `@pierre/diffs` through `Mount`.

## Loops

Not started until the spikes are decided and the scenario list is written.

- **Port loop**: one agent per slice in its own worktree, reruns
  `bun run parity <scenarios>` until the slice is done (above).
- **Integrator**: on a timer, merges done slices, runs the full parity
  suite, `bun test` and `bun run check`; a regression goes back to the slice
  that caused it; a branch touching protected paths is rejected.
- **Review**: agent reviewers on what screenshots can't show: late
  messages for a chat you've left, actions that can fire twice, loadOlder
  edges, optimistic prompts vs the server's copy.
- **Coverage audit**: every `ClientCommand` in `shared/protocol.ts`, every
  keybinding, route and settings section is named by some scenario's
  `covers`.

Machine budget (2 cores, 7 GB): one parity run at a time, at most two
porting agents.

## Known

- `bun test` has 40 failures on this branch before any of this work (socket,
  CLI, cloud integration, terminal); same set with and without it.
- The demo backend didn't answer `github.listRecentRepos`, which the home
  page sends; it now returns `{ available: false, repos: [] }`.
