# Foldkit port: conventions

Read with `docs/foldkit-migration.md` (what "done" means, the rules). This
file is how the code is written.

## Where things go

```
src/foldkit/
  app/        root program: Model, Message, update, view, routing, wiring
  core/       socket resource, snapshot subscriptions, commands, storage,
              theme, keybindings, app dialogs, shared helpers
  ui/         primitives replacing src/client/components/ui (Radix/shadcn)
  markdown/   markdown → Foldkit Html (replaces react-markdown)
  <feature>/  one folder per ported slice: sidebar/, home/, settings/,
              chat/, composer/, transcript/, palette/, terminal/, …
```

- One folder is owned by one agent at a time. `app/` and `core/` are owned
  by the integrator; a slice agent asks for changes there in its report, or
  makes the smallest additive change (a field, a `Got*` Message, a view
  call) and says so.
- Do not edit `src/client/**`. React must keep working until the switch.
  React-free modules there (`src/client/lib/*`, `src/client/app/socket.ts`,
  `kannaStateHelpers.ts`, `derived.ts`, …) are imported as they are. Code
  that is pure but sits inside a React file is copied into the slice
  (keep its comment) and the React copy is left alone.
- `src/shared/**` is shared with the server: import, never fork.

## Code style

- The repo's style: double quotes, no semicolons, 2-space indent, comments
  that say why. Match the density of the React file being ported; carry its
  comments over when they still explain the Foldkit code.
- Foldkit idioms (docs: `/home/dev/foldkit-docs/llms-full.txt`, index in
  `/home/dev/foldkit-docs/INDEX.txt`):
  - Model is a `Schema.Struct`. Snapshot data typed by interfaces in
    `src/shared` goes in with `opaque<T>("Name")` from `core/schema.ts`.
  - Messages from `defineMessageUnion`, past-tense facts:
    `ClickedArchive`, `ReceivedSidebarSnapshot`, `SucceededForkChat`,
    `FailedForkChat`. `Got*` only for a child's Message lifted by a parent.
  - Side effects only in Commands (`Command.define`), Subscriptions, Mounts
    and ManagedResources. `update` and `view` are pure.
  - A slice is a Submodel: `Model`, `Message`, `OutMessage` (facts the
    parent must act on: navigation, opening a dialog), `init`, `update`,
    `view(model, …inputs, h)`. Shared state it only reads (sidebar data,
    settings) comes in as view inputs / update inputs from the parent, not
    copied into its Model.
  - `h` is the last parameter of every view helper.
  - Key list items by stable ids (`h.keyed`).
- Socket commands go through `core/` helpers (a `ClientCommand` in, a
  result or error Message out). The command log is compared with React's,
  so send the same commands, with the same fields, in the same order.

## Matching React

- Same DOM: element types, nesting, `class` strings copied verbatim from
  the JSX (resolve `cn(...)`/`cva` the same way, using
  `src/client/lib/utils.ts`), the same `aria-*`, `role`, `data-*`,
  `title`, `type`, `tabindex`. Radix adds attributes (`data-state`,
  `aria-expanded`, `aria-controls`) that CSS and the accessibility tree
  read; reproduce the ones that matter to either.
- Same text, including whitespace that renders.
- Same timing where it is visible: what shows on the first frame, what
  waits for a snapshot.
- When React is wrong, match it anyway and note it in the report.

## Testing

- Story tests for update logic, Scene tests for views, next to the module
  (`foo.ts` / `foo.test.ts`), under `bun test`.
- Parity: `bun run parity <scenario> [--region <name>]`. Scenarios live in
  `scripts/parity/scenarios/`, one file per area. Gallery pages
  (`src/parity/{react,foldkit}/gallery/<name>.tsx|.ts`, served at
  `/__gallery/<name>`) check a component in isolation.
- The harness, scenarios and the fixture are protected: never change one
  to make a difference go away. Only the agent asked to write scenarios, or
  to build gallery pages, edits them.
- `node_modules/.bin/tsc --noEmit` must stay clean (the `tsconfig.json`
  includes `src/foldkit/**`).

## Worktrees

Port agents work in their own git worktree. If `node_modules` is missing
there, symlink it: `ln -s /home/dev/kanna-foldkit/node_modules node_modules`.
Never run `bun add`; ask for a dependency in the report. Parity runs take a
machine-wide lock, so a run may wait for another agent's; that is
expected. Commit on the worktree's branch; the integrator merges.
