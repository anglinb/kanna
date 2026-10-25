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
bun run parity:coverage              # what no scenario covers, and why
bun run parity:coverage --verify     # also: each scenario sent what its
                                     # `covers` names (.parity/latest)
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

## Status

The architecture (decided by building it; spikes 2–5 above were folded
into this):

- `app/`: the root program. Auth gate, the socket (a ManagedResource opened
  once auth is ready), every app-wide snapshot, routes, the stores
  (`app/stores.ts`), the page's chat session, root actions (`app/actions.ts`,
  what slices ask for via `AppAction`), the app dialog, housekeeping.
- `core/`: socket helpers, the chat session Submodel, the ported stores,
  storage in the React client's formats.
- `ui/`: Radix/shadcn replacements (overlays rebuilt on Floating UI and
  Mounts), lucide icons, provider icons. `markdown/`: react-markdown's.
- Slices (`app/slice.ts` contract), one folder and one agent each:

| Slice | Folder | Wave | Status |
|---|---|---|---|
| Sidebar | `sidebar/` | 1 | merged (route regions pass; page-owned commands pending) |
| Projects page | `home/` | 1 | merged (154/160 with sidebar) |
| Settings page | `settings/` | 1 | merged (612/620) |
| Chat page shell | `chat/` | 1 | merged (own regions pass; selfcheck 156/156) |
| Transcript rows | `transcript/messages/` | 1 | merged (316/316 gallery) |
| Terminal | `terminal/` | 2 | merged (workspace gallery 24/24; page matches but for home's boot command) |
| Command palette | `palette/` | 2 | in progress |
| Composer | `composer/` | 2 | in progress |
| Transcript viewport (+ export viewer) | `transcript/` | 3 | merged (export viewer 12/12; chat captures wait on the composer) |
| Right sidebar widgets | `widgets/` | 3 | to do |
| Viewer / previewer | `viewer/` | 3 | to do |
| Setup wizard | `setup/` | 3 | to do |
| Workflows gallery | `workflows/` | 3 | to do |
| Demo entry, export viewer | `src/demo`, `src/export-viewer` | 4 | to do |
| Switch entries, delete React | — | 4 | to do |

## React-free check

`bun run react-free` walks the Foldkit app's imports and fails on any
path into React or a React library, printing the chain. It must stay
clean; it is also what proves React can be deleted.

## Integration follow-ups

- Sidebar: use `AppAction.Batch` (Archive All, Restore), `OpenChatAt`
  (hover card jumps), `OpenCommandPalette` instead of the window event.
- Projects page: refetch GitHub repos on a sign-in change via `observe`
  (React sends `github.listRecentRepos` twice at boot); use
  `OpenCommandPalette` instead of the window event.
- Create chat from the projects page: the demo backend returns its own
  chat id instead of the client's, so React ends up back at `/`; decide
  whether the fixture should honor the client id (the real server does).
- `scripts/parity/scenarios/terminal.ts`: React sometimes sends
  `terminal.create` twice (a race with the demo's "no shell yet" reply);
  handle it as `terminal-page.ts` does, so the scenarios are deterministic.
- `ui/`: opening a modal Select shouldn't close a tooltip already up
  (Radix registers the new layer before its outside-click check).
- Sidebar and chat tabs share the chat hover card; move it to one module
  (the tab card imports the sidebar's `chatCardBody`).
- `ui/context-menu`: a plain label entry, so `settings/menu.ts` (a local
  copy for the skills menu heading) can go.
- `ui/select`: report a choice only for a new value, as Radix does;
  `settings/shared.ts` `updateSettingsSelect` filters it meanwhile.
- React bugs matched, to file: RawMessageSection never shows the raw
  message (its effect cancels its own request); Escape doesn't close the
  local-link menu.
- Live schedule card in transcript rows (widgets slice) and the
  export viewer's ViewerLayer (viewer slice).
- `@foldkit/vite-plugin` peers on Vite 8; we run Vite 6 (works so far).
- `app/action.ts` imports types from React files
  (`components/messages/shared`, `lib/chat-navigation` is fine); move
  those types before React is deleted.

## Loops

- **Port**: one agent per slice in its own worktree (briefs in
  `/home/dev/foldkit-briefs/`), against its scenarios and regions.
- **Integrate**: the integrator merges a slice when it reports, reruns
  typecheck, `bun test src/foldkit scripts/parity` and the parity suite.
- **Coverage / review**: the scenario suite and coverage audit
  (`scripts/parity/coverage.ts`), then reviews for what screenshots can't
  show.

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
