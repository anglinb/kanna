import os from "node:os"
import path from "node:path"
import { Effect, FileSystem, Option, Schema } from "effect"
import type {
  GlobalSkillsSnapshot,
  InstalledSkillsSnapshot,
  SkillInstallResult,
  SkillSearchSnapshot,
  SkillUninstallResult,
} from "../shared/types"
import { listGlobalSkills } from "./harness-skills"

const SKILL_AGENT_ALIASES = ["universal", "claude-code"] as const

/** A skill source or id from the client that could not be put on a command line. */
export class SkillInputError extends Schema.TaggedError<SkillInputError>()(
  "@kanna/server/skills/SkillInputError",
  {
    message: Schema.String,
  },
) {}

/** skills.sh could not be reached, answered with an error, or sent something other than JSON. */
export class SkillSearchError extends Schema.TaggedError<SkillSearchError>()(
  "@kanna/server/skills/SkillSearchError",
  {
    message: Schema.String,
    status: Schema.optionalKey(Schema.Number),
    cause: Schema.optionalKey(Schema.Defect()),
  },
) {}

/** The skills CLI could not be started, or exited with an error. */
export class SkillCommandError extends Schema.TaggedError<SkillCommandError>()(
  "@kanna/server/skills/SkillCommandError",
  {
    message: Schema.String,
    command: Schema.Array(Schema.String),
    exitCode: Schema.optionalKey(Schema.Number),
    cause: Schema.optionalKey(Schema.Defect()),
  },
) {}

const messageOf = (cause: unknown) => cause instanceof Error ? cause.message : String(cause)

export function assertSafeSkillSource(source: string) {
  const normalized = source.trim()
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(normalized)) {
    throw new Error("Skill source must be an owner/repo pair.")
  }
  return normalized
}

export function assertSafeSkillId(skillId: string) {
  const normalized = skillId.trim()
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(normalized)) {
    throw new Error("Skill id is invalid.")
  }
  return normalized
}

export function getGlobalSkillLockPath() {
  const xdgStateHome = process.env.XDG_STATE_HOME?.trim()
  if (xdgStateHome) {
    return path.join(xdgStateHome, "skills", ".skill-lock.json")
  }
  return path.join(os.homedir(), ".agents", ".skill-lock.json")
}

// The lock file and the search API belong to other tools, so a field of the
// wrong type reads as absent instead of failing the whole file or response.

/** A field kept when it is a string and dropped otherwise. */
const LenientString = Schema.optionalKey(Schema.String.pipe(Schema.catchDecoding(() => Effect.succeedNone)))
/** A field kept when it is a number and dropped otherwise. */
const LenientNumber = Schema.optionalKey(Schema.Number.pipe(Schema.catchDecoding(() => Effect.succeedNone)))

const UnknownRecord = Schema.Record(Schema.String, Schema.Unknown)
const decodeRecord = Schema.decodeUnknownOption(UnknownRecord)

/** `{ skills: { [name]: entry } }`, as the skills CLI writes it. */
const SkillLockFile = Schema.Struct({ skills: UnknownRecord })
const SkillLockEntry = Schema.Struct({
  source: LenientString,
  sourceType: LenientString,
  sourceUrl: LenientString,
  skillPath: LenientString,
  installedAt: LenientString,
  updatedAt: LenientString,
  pluginName: LenientString,
})
const decodeSkillLockFile = Schema.decodeUnknownOption(SkillLockFile)
const decodeSkillLockEntry = Schema.decodeUnknownOption(SkillLockEntry)

export function parseInstalledSkillsLock(parsed: unknown, lockFilePath: string): InstalledSkillsSnapshot {
  const skillsRecord = decodeSkillLockFile(parsed).pipe(
    Option.map((file) => file.skills),
    Option.getOrElse((): Record<string, unknown> => ({})),
  )

  const skills = Object.entries(skillsRecord)
    .flatMap(([name, value]) => Option.toArray(
      // A record first: an array would pass as an entry with no fields.
      decodeRecord(value).pipe(Option.flatMap(decodeSkillLockEntry), Option.map((entry) => ({ name, entry }))),
    ))
    .map(({ name, entry }) => ({
      name,
      source: entry.source ?? "",
      sourceType: entry.sourceType ?? "",
      sourceUrl: entry.sourceUrl ?? "",
      skillPath: entry.skillPath || undefined,
      installedAt: entry.installedAt ?? "",
      updatedAt: entry.updatedAt ?? "",
      pluginName: entry.pluginName || undefined,
    }))
    .sort((a, b) => a.name.localeCompare(b.name))

  return {
    lockFilePath,
    skills,
  }
}

const decodeJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown))

/** The skills the skills CLI installed globally. A missing or unreadable lock file lists none. */
export const listInstalledSkills = Effect.fn("Skills.listInstalled")(function* (lockFilePath: string = getGlobalSkillLockPath()) {
  const fs = yield* FileSystem.FileSystem
  const empty = Effect.succeed<InstalledSkillsSnapshot>({ lockFilePath, skills: [] })
  return yield* fs.readFileString(lockFilePath).pipe(
    Effect.flatMap(decodeJson),
    Effect.map((parsed) => parseInstalledSkillsLock(parsed, lockFilePath)),
    Effect.catchTags({ PlatformError: () => empty, SchemaError: () => empty }),
  )
})

const SearchResultSkill = Schema.Struct({
  id: Schema.String,
  skillId: Schema.String,
  name: Schema.String,
  installs: LenientNumber,
  source: Schema.String,
})
const SearchResponse = Schema.Struct({
  query: LenientString,
  searchType: LenientString,
  skills: Schema.optionalKey(Schema.Array(Schema.Unknown).pipe(Schema.catchDecoding(() => Effect.succeedNone))),
  count: LenientNumber,
  duration_ms: LenientNumber,
})
const decodeSearchResultSkill = Schema.decodeUnknownOption(SearchResultSkill)
const decodeSearchResponse = Schema.decodeUnknownOption(SearchResponse)

export const searchSkills = Effect.fn("Skills.search")(function* (query: string, limit = 100) {
  const normalizedQuery = query.trim()
  if (normalizedQuery.length < 2) {
    return {
      query: normalizedQuery,
      searchType: "fuzzy",
      skills: [],
      count: 0,
      duration_ms: 0,
    } satisfies SkillSearchSnapshot
  }

  const normalizedLimit = Math.max(1, Math.min(100, Math.trunc(limit)))
  const url = new URL("https://skills.sh/api/search")
  url.searchParams.set("q", normalizedQuery)
  url.searchParams.set("limit", String(normalizedLimit))

  const response = yield* Effect.tryPromise({
    try: (signal) => fetch(url, { signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]) }),
    catch: (cause) => new SkillSearchError({ message: messageOf(cause), cause }),
  })
  if (!response.ok) {
    return yield* new SkillSearchError({
      message: `Skills search failed with status ${response.status}.`,
      status: response.status,
    })
  }
  yield* Effect.annotateCurrentSpan("status", response.status)

  const body: unknown = yield* Effect.tryPromise({
    try: () => response.json(),
    catch: (cause) => new SkillSearchError({ message: messageOf(cause), status: response.status, cause }),
  })
  const payload = Option.getOrElse(decodeSearchResponse(body), (): typeof SearchResponse.Type => ({}))
  return {
    query: payload.query ?? normalizedQuery,
    searchType: payload.searchType ?? "fuzzy",
    skills: (payload.skills ?? [])
      .flatMap((skill) => Option.toArray(decodeSearchResultSkill(skill)))
      .map((skill) => ({
        id: skill.id,
        skillId: skill.skillId,
        name: skill.name,
        installs: skill.installs ?? 0,
        source: skill.source,
      })),
    count: payload.count ?? 0,
    duration_ms: payload.duration_ms ?? 0,
  } satisfies SkillSearchSnapshot
})

export function buildInstallSkillCommand(source: string, skillId: string) {
  return [
    process.platform === "win32" ? "npx.cmd" : "npx",
    "skills",
    "add",
    assertSafeSkillSource(source),
    "--skill",
    assertSafeSkillId(skillId),
    "--global",
    "--agent",
    ...SKILL_AGENT_ALIASES,
    "--yes",
  ]
}

export function buildUninstallSkillCommand(skillId: string) {
  return [
    process.platform === "win32" ? "npx.cmd" : "npx",
    "skills",
    "remove",
    assertSafeSkillId(skillId),
    "--global",
    "--agent",
    ...SKILL_AGENT_ALIASES,
    "--yes",
  ]
}

/** `build` with the input it rejects as a typed failure, not a thrown error. */
const buildCommand = (build: () => string[]) =>
  Effect.try({ try: build, catch: (cause) => new SkillInputError({ message: messageOf(cause) }) })

/** Runs the skills CLI to the end. Interrupting it kills the process. */
const runSkillCommand = Effect.fn("Skills.runCommand")(function* (command: string[]) {
  yield* Effect.annotateCurrentSpan("command", command.slice(0, 3).join(" "))
  const cwd = os.homedir()
  const subprocess = yield* Effect.acquireRelease(
    Effect.try({
      try: () => Bun.spawn(command, {
        cwd,
        stdout: "pipe",
        stderr: "pipe",
        env: {
          ...process.env,
          DISABLE_TELEMETRY: process.env.DISABLE_TELEMETRY ?? "1",
        },
      }),
      catch: (cause) => new SkillCommandError({ message: messageOf(cause), command, cause }),
    }),
    (subprocess) => Effect.sync(() => {
      if (subprocess.exitCode === null) subprocess.kill()
    }),
  )

  const [stdout, stderr, exitCode] = yield* Effect.tryPromise({
    try: () => Promise.all([
      new Response(subprocess.stdout).text(),
      new Response(subprocess.stderr).text(),
      subprocess.exited,
    ]),
    catch: (cause) => new SkillCommandError({ message: messageOf(cause), command, cause }),
  })

  if (exitCode !== 0) {
    return yield* new SkillCommandError({
      message: stderr.trim() || stdout.trim() || `skills CLI exited with code ${exitCode}.`,
      command,
      exitCode,
    })
  }

  return { cwd, stdout, stderr }
}, Effect.scoped)

export const installSkill = Effect.fn("Skills.install")(function* (source: string, skillId: string) {
  const command = yield* buildCommand(() => buildInstallSkillCommand(source, skillId))
  const { cwd, stdout, stderr } = yield* runSkillCommand(command)
  return {
    source: command[3],
    skillId: command[5],
    command,
    cwd,
    stdout,
    stderr,
  } satisfies SkillInstallResult
})

export const uninstallSkill = Effect.fn("Skills.uninstall")(function* (skillId: string) {
  const command = yield* buildCommand(() => buildUninstallSkillCommand(skillId))
  const { cwd, stdout, stderr } = yield* runSkillCommand(command)
  return {
    skillId: command[3],
    command,
    cwd,
    stdout,
    stderr,
  } satisfies SkillUninstallResult
})

/**
 * The settings "Installed" view: scan the global skill roots the harnesses
 * read (~/.agents, ~/.claude, ~/.cursor, ~/.codex) with per-harness
 * attribution, then annotate entries the skills-CLI lock file knows about with
 * their marketplace source — those get skills.sh links and an uninstall
 * affordance; hand-dropped skills are listed without them.
 */
export const listGlobalSkillsWithSources = Effect.fn("Skills.listGlobalWithSources")(function* (args: {
  home?: string
  lockFilePath?: string
} = {}) {
  const scanned = yield* listGlobalSkills({ home: args.home })
  const lock = yield* listInstalledSkills(args.lockFilePath ?? getGlobalSkillLockPath())
  const sourceByName = new Map(
    lock.skills
      .filter((skill) => skill.source)
      .map((skill) => [skill.name, skill.source])
  )
  return {
    skills: scanned.map((skill) => {
      const source = sourceByName.get(skill.name)
      return source ? { ...skill, source } : skill
    }),
  } satisfies GlobalSkillsSnapshot
})
