# Kanna — development notes

Kanna is a local web UI for coding agents (Claude Code, Codex, Cursor, Pi).
Bun server + React 19 client, talking over one WebSocket.

## Commands

- `bun run dev` — client (Vite) + server together
- `bun test` — unit/integration suite (Bun test)
- `bun run check` — typecheck + both production builds
- `bun run build` — client + export-viewer bundles

## How it fits together

```
React client (src/client)
  socket.ts ── one WebSocket ──► WSRouter (src/server/ws-router.ts)
                                   ├─ commands: switch on ClientCommand (shared/protocol.ts)
                                   ├─ snapshots: per-topic push with dedupe signatures
                                   ├─ AgentCoordinator (agent.ts) ── provider adapters:
                                   │    Claude Agent SDK (in agent.ts) · codex-app-server.ts
                                   │    cursor-cli.ts · pi-agent.ts
                                   └─ EventStore (event-store.ts): JSONL logs + snapshot
                                      compaction + per-chat transcripts (~/.kanna/data)
```

- **Everything the client renders comes from server snapshots** pushed per
  subscription topic (`sidebar`, `chat`, `project-git`, `local-projects`,
  `update`, `keybindings`, `app-settings`, `terminal`). The client sends
  commands; it never mutates server state locally except optimistic user
  prompts (reconciled by content signature).
- Snapshot pushes dedupe by signature: sidebar/chat use the serialized
  snapshot itself (built once per broadcast and shared across sockets),
  project-git uses a version counter. Keep that property when adding topics.
- A chat subscription holds a window of the transcript, not all of it:
  the last N assistant messages (`transcript.windowAssistantMessages`,
  default 50), widened to reach the read anchor. `chat.loadOlder` moves the
  window back and the older slice arrives as an incremental push that lands
  in front. `outline` on the snapshot names every user prompt so the minimap
  covers the whole chat. Logic in `src/shared/transcript-window.ts`.
- Provider adapters normalize three different wire protocols into
  `HarnessEvent`s (`harness-types.ts`). Claude runs through the Agent SDK in
  `agent.ts` directly; codex/cursor/pi produce `HarnessTurn`s.
- Shutdown cancels every in-flight turn and marks its chat `resumePending`
  (`agent.interruptForShutdown`); the next boot restarts those turns with a
  wire-only "carry on" prompt (`resume-turns.ts`). A user-initiated cancel
  never sets the marker, and the marker is cleared before the attempt, so one
  shutdown earns one resume.
- Chat titles are generated twice: once from the opening message
  (`generate-title.ts`, optimistic fallback first), then once more after the
  first turn finishes (`refine-title.ts`), where a small model may replace a
  title too generic to find the chat by. `ChatRecord.titleSource` gates the
  second pass — a rename with no source is a person typing, and nothing
  automatic touches the title again.
- Transcripts are append-only JSONL per chat (`transcripts/<chatId>.jsonl`)
  with a small LRU cache in the EventStore. `debugRaw` (raw provider JSON) is
  stamped only on `system_init` — the one entry with a raw JSON view. Tool
  results keep `tool_use_result` as `structuredResult` instead, and only for
  `ask_user_question` / `exit_plan_mode`.
- The transcript file holds entries in header form. Tool bodies (file
  contents, edits, command output) live in `transcripts/<chatId>.payloads.jsonl`
  and are read by byte offset when a row is opened (`transcript-payloads.ts`).
  Images in tool results are files under `media/<chatId>/`, referenced by URL
  (`transcript-media.ts`). `getMessages()` merges everything back for export,
  handoff and fork. `slimTranscripts` rewrites older transcripts to this shape
  once per data dir (`kanna slim-transcripts` forces it). Agents handed a
  transcript path see headers only.

## Conventions

- `src/shared/` is imported by both sides — no Bun/node imports there.
- New WS commands: add to `shared/protocol.ts`, handle in `ws-router.ts`,
  and prefer targeted `broadcastFilteredSnapshots({...})` over full
  broadcasts (name exactly the topics the command can change).
- Tests live next to their module (`foo.ts` / `foo.test.ts`) and run in Bun.
  The `.e2e.ts` suffix keeps a file out of `bun test`'s default sweep (used
  by the cloud wire e2e).
- When tests need git, they create throwaway repos; in sandboxes set
  `GIT_CONFIG_GLOBAL` to a clean config so URL rewrites/identity don't leak in.

## iOS app (`ios/`)

- `ios/` is its own git repository (ignored by this one). Commit iOS
  changes there.
- The web client and the iOS app share most screens (composer, sidebar,
  chat). When a bug report or request does not say which one it is about,
  ask before touching code. A fix on the wrong platform is wasted work.

## Remote REST API (`src/server/api/`)

- Off by default *for people*. `kanna --api --api-key=<k1,k2>` (or
  `--api-key-file=<path>`, one key per line) is what lets a human client use
  `/api/v1`; pair with `--remote` to reach it off-loopback. `--api` without
  keys is a startup error — the API has no session, origin check or login in
  front of it, so an unkeyed one would be wide open.
- The routes are *always* mounted for one caller: Kanna's own agent bridge,
  holding a per-run key minted at startup (`kanna-mcp-bridge.ts`). That key is
  accepted only on requests that came straight off loopback with no forwarding
  headers (`api/local-request.ts`). Peer address alone is not enough —
  cloudflared runs on this machine under `--share`, so every tunnelled request
  looks like loopback; and `requestClass` alone is not enough either, since it
  reports "local" for a LAN peer when no cloud runtime is attached. Without
  `--api`, anything relayed still gets the JSON 404 as before.
- `control.ts` holds the operations; `routes.ts` and the agent-facing MCP
  tools are both thin shells over it, so HTTP and tools cannot drift. It calls
  the same `EventStore` and `AgentCoordinator` the socket does, then
  `broadcastSnapshots()`, so a chat created either way shows up in a connected
  browser straight away. It deliberately does *not* reuse ws-router's
  `handleCommand`, which is bound to a socket — when you change the semantics
  of `chat.send`, `chat.delete` or `project.open` there, check whether
  `control.ts` needs the same change.
- Anything a request can name that the harness looks up later must be
  validated in `control.ts`, not at the route — the agent-facing tools reach
  the same functions. `provider` in particular: an unknown one only surfaces
  when the turn is set up, and for a queued prompt that is after the 202, in
  `dequeueAndStartQueuedMessage` — which removes the queued message before the
  catalog lookup throws, so the prompt would be acknowledged and then silently
  dropped.
- Prompts are async: `POST /chats/:id/messages` answers 202 and the caller
  polls `GET /chats/:id`. A turn runs far longer than any HTTP client will
  wait. `queued: true` means it landed behind a running turn.
- `POST /reload` re-reads the data dir into the running process, for editing
  it underneath a live Kanna (moving a chat between projects, importing one)
  without a restart. See `EventStore.reload` — it is deliberately *not*
  `initialize()`: the boot path answers an unreadable snapshot or a foreign
  store version by calling `clearStorage()`, which truncates every log, and
  doing that to someone who was mid-edit would be unrecoverable. Everything is
  validated first, a bad file is a 409 with the previous state still loaded,
  and a `reloading` latch makes `clearStorage` throw rather than run. It also
  goes through the write chain, so a turn appending mid-reload lands wholly
  before or after. A chat that vanished from disk but still had a live harness
  session is released (cancel + close) and named in `droppedChatIds`.
- The route claims `/api/v1` even when the API is unmounted, answering a JSON
  404 — otherwise the SPA fallback returns index.html with a 200 and a client
  cannot tell the API is off (same reason `/__cloud` 404s explicitly).
- A valid key substitutes for the `--password` session on `/api/v1` only;
  every other `/api/` route still needs the cookie. Raw cloud-tunnel traffic
  (`requestClass === "untrusted"`) still sees nothing but `/health` and `/ws`,
  so the API is not reachable through a paired machine's tunnel by design.
- `/health` reports `api`, so a second `kanna --api` against an already-running
  instance can tell that its flags will not take effect: it exits 1 asking for
  a restart when that instance has no API, and warns that this run's keys were
  not applied when it does.

## Agents managing Kanna (`kanna-tools.ts` and friends)

- Claude and Codex sessions get tools for Kanna itself: list/open projects,
  list/read/create chats, send prompts, cancel turns, and `reload` (re-read
  the data dir after editing it directly). `kanna-tools.ts` is the single
  definition — names, descriptions and Zod shapes — and both transports read
  from it, so the two agents see the same toolbox.
- Two transports because the harnesses differ. Claude takes an in-process
  server (`createSdkMcpServer`, in `kanna-mcp-claude.ts`) whose handlers call
  `control.ts` directly: no HTTP, no child process, no key on disk. Codex has
  no such hook, so its sessions spawn `kanna mcp <credentials>`
  (`kanna-mcp-stdio.ts`) via `-c mcp_servers.kanna.*` overrides on
  `codex app-server`, and that child calls back over `/api/v1`.
- Schemas are Zod raw shapes because the Agent SDK's `tool()` rejects a plain
  JSON Schema outright. The stdio bridge derives real JSON Schema from the
  same shapes with `z.toJSONSchema`. Don't "simplify" one side into hand-
  written JSON Schema; the SDK will throw at session start.
- MCP tools are not filtered by the SDK's `tools` option — that selects
  built-ins only — so nothing in `claudeToolset` gates these.
- Credentials go in a 0600 file under `<dataDir>/mcp/`, one per chat, not in
  argv or the environment: `ps` shows a child's command line to every user on
  the machine, and codex passes its own environment to the servers it spawns.
  `stopSession` deletes the file; shutdown removes the directory.
- **Fan-out is bounded to one hop.** A chat an agent created carries
  `ChatRecord.agentOrigin`, and a chat with it set may not create chats or
  send messages (`assertMaySpawn`). An agent also cannot prompt its own chat.
  The marker is persisted, not counted in memory, because boot resumes
  interrupted turns and an in-memory depth would reset to zero; `forkChat`
  copies it for the same reason.
- `agentOrigin` is deliberately *not* a field on `ClientCommand` — it rides an
  out-of-band options argument to `agent.send`, and over HTTP it comes from
  `X-Kanna-Agent-Chat`, honoured only for the internal key. A browser must not
  be able to label a chat it opened as agent work.
- No delete tool, by design: removing a project or chat destroys work with no
  undo in the UI. `DELETE /chats/:id` still exists for human API clients.
- `kanna mcp` is not in `--help`. It takes a path to a file a running Kanna
  wrote and is meaningless to type by hand.

## Release-candidate channel (fork only)

- RC builds are this fork's own distribution: `rc-release.yml` stamps the
  checkout as `@anglinb/kanna-rc`, packs it, and attaches the tarball to a
  prerelease GitHub Release. Nothing goes to npm. The client half is
  `src/server/rc-channel.ts`, deliberately its own module so merges from
  upstream stay conflict-free — prefer adding to it over threading `rc` cases
  through `cli-runtime.ts`.
- The separate package name is load-bearing twice over. A global install is
  keyed by package name, so shipping RCs as `kanna-code` would replace a
  teammate's stable install (and take over its `kanna` bin); and a running RC
  looks up `getPackageName()`, so sharing the name would make it check npm and
  quietly auto-update itself into an upstream build. `getPackageName()` is
  what routes a build to its channel — `cli.ts` picks the matching
  fetch/install pair via `getReleaseChannel()`.
- **Bun cannot move a global entry from one tarball spec to another in place**
  — it aborts with `DependencyLoop` and leaves the old build installed. Every
  RC upgrade is tarball→tarball, so `installRcVersion` removes the global entry
  before installing. That also means a failed install would leave the machine
  with no `kanna-rc` at all, hence the rollback to the previously installed
  version. Don't drop either step; the first install works fine without them
  and every upgrade after it fails.
- `compareVersions` understands prerelease precedence so `-rc.1` < `-rc.2`;
  without it every candidate for a base version compares equal and RCs never
  update. Nightly is the deliberate exception: `-nightly.<sha>` is cut from
  main *after* its base shipped, so it stays level with the base rather than
  ranking below it, or the stable updater would reinstall over a nightly on
  every launch.
- The RC version is computed at build time (`scripts/rc-release.ts`) and never
  committed, so `package.json` keeps upstream's version verbatim and doesn't
  conflict on every merge. The tag (`v<version>`) and asset name both follow
  from the version, which is why installing needs no GitHub API round trip and
  `installVersion` can stay synchronous.
- Nightly is disabled on rc builds: it builds upstream's `main`, so installing
  one from an RC would swap the fork out for an upstream build.

## Cloud contract

- `src/shared/cloud-api.ts` is the wire contract with the hosted control
  plane/proxy (kanna-site, a separate private repo that deploys
  independently). It is **append-only**: never remove or rename a field or
  constant; add optional fields only — machines in the wild must keep working.
  The file is mirrored verbatim at `kanna-site/src/shared/cloud-api.ts`; keep
  the two copies identical when changing either.
- The machine side lives in `src/server/cloud/` (identity file, control-plane
  client, tunnel supervisor, request guard). The hosted proxy sees proxied
  HTTP but never WebSocket frames — the browser's WS connects directly to the
  machine's tunnel.
- `bun run test:cloud` runs the cross-repo wire e2e against a local
  `wrangler dev` of `../kanna-site` (skips if the sibling repo is missing).
