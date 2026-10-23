import { afterEach, expect, test } from "bun:test"
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { Deferred, Effect, Result, Stream } from "effect"
import { Analytics, NoopAnalytics } from "./analytics"
import { runTest } from "./effect/testing"
import { makeProviderAuth, ProviderAuth, type ProviderAuthOptions } from "./provider-auth"
import { accountEnvironment, makeProviderAccounts, withAccounts } from "./provider-accounts"

const directories: string[] = []
afterEach(async () => { await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))) })
async function directory() { const dir = await mkdtemp(path.join(tmpdir(), "kanna-accounts-")); directories.push(dir); return dir }
const make = (dir: string, native?: ProviderAuthOptions) => Effect.gen(function* () {
  const legacy = yield* makeProviderAuth({ services: [] })
  return yield* makeProviderAccounts(dir, native).pipe(Effect.provideService(ProviderAuth, legacy))
}).pipe(Effect.provideService(Analytics, NoopAnalytics))

test("persists independent account keys and defaults without exposing credentials in snapshots", async () => {
  const dir = await directory()
  const work = await runTest(Effect.gen(function* () {
    const accounts = yield* make(dir)
    const work = yield* accounts.create({ provider: "pi", label: "Work", apiKey: "secret-work", apiProvider: "openrouter" })
    const personal = yield* accounts.create({ provider: "pi", label: "Personal", apiKey: "secret-personal" })
    yield* accounts.setDefault("pi", work)
    const first = yield* accounts.runtime("pi")
    yield* accounts.setDefault("pi", personal)
    expect((yield* accounts.runtime("pi", first.accountId)).connection?.apiKey).toBe("secret-work")
    expect((yield* accounts.runtime("pi")).connection?.apiKey).toBe("secret-personal")
    expect(JSON.stringify(yield* accounts.snapshot)).not.toContain("secret-")
    expect((yield* accounts.runtime("pi", "existing-pi")).connection).toBeUndefined()
    yield* accounts.setDefault("pi", work)
    return work
  }))
  expect((await stat(path.join(dir, "accounts.json"))).mode & 0o777).toBe(0o600)
  await runTest(Effect.gen(function* () {
    const accounts = yield* make(dir)
    expect((yield* accounts.runtime("pi")).accountId).toBe(work)
    expect((yield* accounts.runtime("pi")).connection?.baseUrl).toBe("https://openrouter.ai/api/v1")
    yield* accounts.updateKey(work, "rotated-work-key")
    expect((yield* accounts.runtime("pi", work)).connection?.apiKey).toBe("rotated-work-key")
    expect(JSON.stringify(yield* accounts.snapshot)).not.toContain("rotated-work-key")
    yield* accounts.rename(work, "Company")
    expect((yield* accounts.snapshot).accounts.find((account) => account.id === work)?.label).toBe("Company")
    yield* accounts.remove(work)
    expect((yield* accounts.runtime("pi")).accountId).toBe("existing-pi")
    expect(Result.isFailure(yield* Effect.result(accounts.runtime("pi", work)))).toBe(true)
  }))
  expect(await readFile(path.join(dir, "accounts.json"), "utf8")).not.toContain("secret-work")
})

test("rejects mismatched provider accounts and invalid definitions without changing storage", async () => {
  const dir = await directory()
  await runTest(Effect.gen(function* () {
    const accounts = yield* make(dir)
    const cursor = yield* accounts.create({ provider: "cursor", label: "Work", apiKey: "cursor-secret" })
    for (const operation of [
      accounts.setDefault("claude", cursor), accounts.runtime("claude", "existing-codex"),
      accounts.create({ provider: "grok", label: "Work" }),
      accounts.create({ provider: "cursor", label: "No key" }),
      accounts.create({ provider: "pi", label: "Custom", apiKey: "key", apiProvider: "custom" }),
      accounts.create({ provider: "pi", label: "Bad URL", apiKey: "key", baseUrl: "https://user:password@example.com" }),
      accounts.create({ provider: "cursor", label: " ", apiKey: "key" }),
      accounts.rename(cursor, " "), accounts.remove("../../other"),
    ]) expect(Result.isFailure(yield* Effect.result(operation))).toBe(true)
    expect((yield* accounts.snapshot).accounts.filter((account) => account.mode !== "existing")).toHaveLength(1)
    expect((yield* accounts.runtime("cursor", cursor)).environment?.CURSOR_API_KEY).toBe("cursor-secret")
  }))
})

test("concurrent account saves survive restart, and malformed storage fails closed", async () => {
  const dir = await directory()
  await runTest(Effect.gen(function* () {
    const accounts = yield* make(dir)
    yield* Effect.all(Array.from({ length: 8 }, (_, index) => accounts.create({ provider: "cursor", label: `Account ${index}`, apiKey: `key-${index}` })), { concurrency: "unbounded" })
    expect((yield* accounts.snapshot).accounts.filter((account) => account.mode === "apiKey")).toHaveLength(8)
  }))
  await runTest(Effect.gen(function* () { expect((yield* (yield* make(dir)).snapshot).accounts.filter((account) => account.mode === "apiKey")).toHaveLength(8) }))
  await writeFile(path.join(dir, "accounts.json"), '{"version":1,"accounts":[{"id":"../../escape","provider":"cursor","mode":"apiKey","label":"bad"}],"defaults":{}}')
  expect(Result.isFailure(await runTest(Effect.result(make(dir))))).toBe(true)
})

test("native accounts isolate login processes, status probes and code submission", async () => {
  const dir = await directory()
  const signedIn = new Set<string>()
  const logins: string[] = []
  const probes: string[] = []
  const options: ProviderAuthOptions = {
    resolveCommandPath: (command) => Effect.succeed(`/fixtures/${command}`),
    isExecutable: () => Effect.succeed(true),
    exec: (argv, opts) => Effect.sync(() => {
      if (argv.includes("--version")) return { code: 0, stdout: "999.0.0 (Claude Code)", stderr: "" }
      const profile = opts?.env?.CLAUDE_CONFIG_DIR ?? "unscoped"
      probes.push(profile)
      return { code: 0, stdout: JSON.stringify({ loggedIn: signedIn.has(profile), email: signedIn.has(profile) ? `${path.basename(path.dirname(profile))}@example.com` : null }), stderr: "" }
    }),
    spawnPty: (_argv, opts) => Effect.gen(function* () {
      const profile = opts?.env?.CLAUDE_CONFIG_DIR ?? "unscoped"
      logins.push(profile)
      const done = yield* Deferred.make<number>()
      return {
        output: Stream.make("https://claude.ai/oauth/authorize?client_id=fixture&state=test"), exited: Deferred.await(done),
        write: () => Effect.gen(function* () { signedIn.add(profile); yield* Deferred.succeed(done, 0).pipe(Effect.asVoid) }),
      }
    }),
  }
  await runTest(Effect.gen(function* () {
    const accounts = yield* make(dir, options)
    const work = yield* accounts.create({ provider: "claude", label: "Work" })
    const personal = yield* accounts.create({ provider: "claude", label: "Personal" })
    expect(JSON.parse(yield* Effect.promise(() => readFile(path.join(dir, "accounts", work, "claude", "settings.json"), "utf8")))).toEqual({ forceLoginMethod: "claudeai" })
    yield* accounts.login(work)
    yield* accounts.login(personal)
    const waitFor = (predicate: (snapshot: Effect.Success<typeof accounts.snapshot>) => boolean) => Effect.gen(function* () {
      for (let attempt = 0; attempt < 100; attempt++) {
        if (predicate(yield* accounts.snapshot)) return
        yield* Effect.sleep("5 millis")
      }
      throw new Error("Account state did not update")
    })
    yield* waitFor((snapshot) => snapshot.accounts.filter((account) => [work, personal].includes(account.id)).every((account) => account.login.phase === "waiting_for_code_entry"))
    expect(Result.isFailure(yield* Effect.result(accounts.runtime("claude", work)))).toBe(true)
    yield* accounts.submitCode(work, "fixture-code")
    yield* waitFor((snapshot) => snapshot.accounts.some((account) => account.id === work && account.authStatus === "signed_in" && account.login.phase === "idle"))
    const snapshot = yield* accounts.snapshot
    expect(snapshot.accounts.find((account) => account.id === personal)?.login.phase).toBe("waiting_for_code_entry")
    expect(snapshot.accounts.find((account) => account.id === personal)?.authStatus).toBe("signed_out")
    const runtime = yield* accounts.runtime("claude", work)
    expect(runtime.environment?.CLAUDE_CONFIG_DIR).toBe(path.join(dir, "accounts", work, "claude"))
    expect(runtime.environment?.ANTHROPIC_API_KEY).toBeUndefined()
    expect(new Set(logins).size).toBe(2)
    expect(probes.every((profile) => profile.startsWith(path.join(dir, "accounts")))).toBe(true)
    yield* accounts.cancelLogin(personal)
    yield* accounts.setDefault("claude", work)
    const native = yield* makeProviderAuth({ services: [] }).pipe(Effect.provideService(Analytics, NoopAnalytics))
    const merged = withAccounts(yield* native.snapshot, yield* accounts.snapshot)
    expect(merged.services.find((service) => service.service === "claude")?.accountId).toBe(work)
    expect(JSON.stringify(merged)).not.toContain("fixture-code")
  }))
})

test("profile overrides clear inherited auth sources and keep providers separate", () => {
  expect(accountEnvironment("claude", "/profiles/work")).toMatchObject({ CLAUDE_CONFIG_DIR: "/profiles/work", CLAUDE_CODE_OAUTH_TOKEN: undefined, ANTHROPIC_API_KEY: undefined, ANTHROPIC_BASE_URL: undefined })
  expect(accountEnvironment("codex", "/profiles/work")).toEqual({ CODEX_HOME: "/profiles/work", OPENAI_API_KEY: undefined, CODEX_API_KEY: undefined, OPENAI_BASE_URL: undefined })
  expect(accountEnvironment("cursor", "/profiles/work", "key")).toEqual({ CURSOR_API_KEY: "key" })
})

test("Codex profiles select private file credentials for probes and logout", async () => {
  const dir = await directory()
  const calls: Array<{ argv: readonly string[]; home: string | undefined }> = []
  const options: ProviderAuthOptions = {
    resolveCommandPath: () => Effect.succeed("/fixtures/codex"), isExecutable: () => Effect.succeed(true),
    exec: (argv, opts) => Effect.sync(() => {
      calls.push({ argv, home: opts?.env?.CODEX_HOME })
      return argv.includes("--version") ? { code: 0, stdout: "codex-cli 999.0.0", stderr: "" }
        : argv.includes("logout") ? { code: 0, stdout: "Logged out", stderr: "" }
        : { code: 1, stdout: "", stderr: "Not logged in" }
    }),
  }
  await runTest(Effect.gen(function* () {
    const accounts = yield* make(dir, options)
    const id = yield* accounts.create({ provider: "codex", label: "Work" })
    const home = path.join(dir, "accounts", id, "codex")
    expect((yield* accounts.runtime("codex", id)).environment?.CODEX_HOME).toBe(home)
    expect(yield* Effect.promise(() => readFile(path.join(home, "config.toml"), "utf8"))).toContain('cli_auth_credentials_store = "file"')
    expect((yield* Effect.promise(() => stat(home))).mode & 0o777).toBe(0o700)
    yield* accounts.remove(id)
    expect(calls.some((call) => call.argv.includes("logout"))).toBe(true)
    expect(calls.every((call) => call.home === home && call.argv[1] === "-c" && call.argv[2] === 'cli_auth_credentials_store="file"')).toBe(true)
    expect(Result.isFailure(yield* Effect.result(accounts.runtime("codex", id)))).toBe(true)
  }))
})
