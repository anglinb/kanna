import { Effect, Schema } from "effect"
import { Command, Submodel } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { defineMessageUnion } from "foldkit/message"
import { copyTextToClipboard } from "../../client/lib/clipboard"
import { cn } from "../../client/lib/utils"
import { AppAction } from "../app/action"
import { opaque } from "../core/schema"
import { changelogMarkdown, markdown } from "../markdown"
import { DownloadCloud } from "../ui/icons"
import { makeSectionMount } from "./activeSection"
import { requestActions, sectionLabel, sectionSubtitle, type AppModel, type SectionReturn, type SectionViewInputs } from "./section"
import { sectionContainer, settingsActionButton, settingsBadge, settingsNotice, settingsPlaceholder } from "./shared"

// Settings › Changelog (app/settings/ChangelogSection.tsx and SettingsPage's
// useChangelog). The release loading below is copied from that React file
// (it imports react-markdown), cache included.

const GITHUB_RELEASES_URL = "https://api.github.com/repos/jakemor/kanna/releases"
const CHANGELOG_CACHE_TTL_MS = 5 * 60 * 1000
const COPIED_FEEDBACK_MS = 2000

export type GithubRelease = {
  id: number
  name: string | null
  tag_name: string
  html_url: string
  published_at: string | null
  body: string | null
  prerelease: boolean
  draft: boolean
}

export type ChangelogStatus = "idle" | "loading" | "success" | "error"

type ChangelogCache = {
  expiresAt: number
  releases: GithubRelease[]
}

let changelogCache: ChangelogCache | null = null

export function resetChangelogCache() {
  changelogCache = null
}

export async function fetchGithubReleases(fetchImpl: typeof fetch = fetch): Promise<GithubRelease[]> {
  const response = await fetchImpl(GITHUB_RELEASES_URL, {
    headers: {
      Accept: "application/vnd.github+json",
    },
  })
  if (!response.ok) {
    throw new Error(`GitHub releases request failed with status ${response.status}`)
  }

  const payload = await response.json() as GithubRelease[]
  return payload.filter((release) => !release.draft)
}

export function getCachedChangelog() {
  if (!changelogCache) return null
  if (Date.now() >= changelogCache.expiresAt) {
    changelogCache = null
    return null
  }
  return changelogCache.releases
}

export function setCachedChangelog(releases: GithubRelease[]) {
  changelogCache = {
    releases,
    expiresAt: Date.now() + CHANGELOG_CACHE_TTL_MS,
  }
}

export async function loadChangelog(options?: { force?: boolean }) {
  const cached = options?.force ? null : getCachedChangelog()
  if (cached) {
    return cached
  }

  const releases = await fetchGithubReleases()
  setCachedChangelog(releases)
  return releases
}

export function formatPublishedDate(value: string | null) {
  if (!value) return "Unpublished"

  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) return "Unknown date"

  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(parsed)
}

// MODEL

const Releases = opaque<GithubRelease[]>("GithubReleases")

export const Model = Schema.Struct({
  status: Schema.Literals(["idle", "loading", "success", "error"]),
  releases: Releases,
  error: Schema.NullOr(Schema.String),
  /** Bumped per load, so a load overtaken by a retry is ignored. */
  loadVersion: Schema.Number,
  /** The code block whose copy button shows its check. */
  copied: Schema.NullOr(Schema.Struct({ releaseId: Schema.Number, block: Schema.Number, version: Schema.Number })),
})
export type Model = typeof Model.Type

export function init(): Model {
  return { status: "idle", releases: [], error: null, loadVersion: 0, copied: null }
}

// MESSAGE

export const Message = defineMessageUnion({
  MountedSection: {},
  UnmountedSection: {},
  SucceededLoadChangelog: { version: Schema.Number, releases: Releases },
  FailedLoadChangelog: { version: Schema.Number, error: Schema.String },
  ClickedRetry: {},
  ClickedInstallUpdate: {},
  ClickedCheckForUpdates: {},
  ClickedCopyCode: { releaseId: Schema.Number, block: Schema.Number, text: Schema.String },
  CopiedCode: { releaseId: Schema.Number, block: Schema.Number, copied: Schema.Boolean },
  ElapsedCopiedFeedback: { version: Schema.Number },
})
export type Message = typeof Message.Type

type Return = SectionReturn<Model, Message>

export const LoadChangelog = Command.define("LoadChangelog", {
  args: { version: Schema.Number, force: Schema.Boolean },
  messages: [Message.SucceededLoadChangelog, Message.FailedLoadChangelog],
  execute: ({ version, force }) => Effect.tryPromise(() => loadChangelog(force ? { force: true } : undefined)).pipe(
    Effect.map((releases) => Message.SucceededLoadChangelog({ version, releases })),
    Effect.catch((error) => Effect.succeed(Message.FailedLoadChangelog({
      version,
      error: error.cause instanceof Error ? error.cause.message : "Unable to load changelog.",
    }))),
  ),
})

const CopyCode = Command.define("CopyChangelogCode", {
  args: { releaseId: Schema.Number, block: Schema.Number, text: Schema.String },
  messages: [Message.CopiedCode],
  execute: ({ releaseId, block, text }) => Effect.promise(() => copyTextToClipboard(text).catch(() => false)).pipe(
    Effect.map((copied) => Message.CopiedCode({ releaseId, block, copied })),
  ),
})

const WaitCopiedFeedback = Command.define("WaitChangelogCopiedFeedback", {
  args: { version: Schema.Number },
  messages: [Message.ElapsedCopiedFeedback],
  execute: ({ version }) => Effect.sleep(COPIED_FEEDBACK_MS).pipe(Effect.as(Message.ElapsedCopiedFeedback({ version }))),
})

function startLoad(model: Model, force: boolean): Return {
  const version = model.loadVersion + 1
  return {
    model: { ...model, status: "loading", error: null, loadVersion: version },
    commands: [LoadChangelog({ version, force })],
  }
}

export function update(model: Model, message: Message, _app: AppModel): Return {
  return Message.match<Return>(message, {
    MountedSection: () => startLoad(model, false),
    UnmountedSection: () => ({ model: init() }),
    SucceededLoadChangelog: ({ version, releases }) =>
      version === model.loadVersion ? { model: { ...model, releases, status: "success" } } : { model },
    FailedLoadChangelog: ({ version, error }) =>
      version === model.loadVersion ? { model: { ...model, error, status: "error" } } : { model },
    ClickedRetry: () => {
      resetChangelogCache()
      return startLoad(model, true)
    },
    ClickedInstallUpdate: () => requestActions(model, [AppAction.InstallUpdate()]),
    ClickedCheckForUpdates: () => requestActions(model, [AppAction.CheckForUpdates({ force: true })]),
    ClickedCopyCode: ({ releaseId, block, text }) => ({ model, commands: [CopyCode({ releaseId, block, text })] }),
    CopiedCode: ({ releaseId, block, copied }) => {
      if (!copied) return { model }
      const version = (model.copied?.version ?? 0) + 1
      return { model: { ...model, copied: { releaseId, block, version } }, commands: [WaitCopiedFeedback({ version })] }
    },
    ElapsedCopiedFeedback: ({ version }) =>
      model.copied?.version === version ? { model: { ...model, copied: null } } : { model },
  })
}

// VIEW

function gitHubIcon<Message>(className: string, h: HtmlBuilder<Message>): Html {
  return h.svg([
    h.Attribute("viewBox", "0 0 24 24"),
    h.Attribute("fill", "currentColor"),
    h.Attribute("aria-hidden", "true"),
    h.Class(className),
  ], [
    h.path([h.Attribute("d", "M12 .5C5.649.5.5 5.649.5 12A11.5 11.5 0 0 0 8.36 22.04c.575.106.785-.25.785-.556 0-.274-.01-1-.015-1.962-3.181.691-3.853-1.532-3.853-1.532-.52-1.322-1.27-1.674-1.27-1.674-1.038-.71.08-.695.08-.695 1.148.08 1.752 1.178 1.752 1.178 1.02 1.748 2.676 1.243 3.328.95.103-.738.399-1.243.725-1.53-2.54-.289-5.211-1.27-5.211-5.65 0-1.248.446-2.27 1.177-3.07-.118-.288-.51-1.45.112-3.024 0 0 .96-.307 3.145 1.173A10.91 10.91 0 0 1 12 6.03c.973.004 1.954.132 2.87.387 2.182-1.48 3.14-1.173 3.14-1.173.625 1.573.233 2.736.115 3.024.734.8 1.175 1.822 1.175 3.07 0 4.39-2.676 5.358-5.224 5.642.41.353.776 1.05.776 2.117 0 1.528-.014 2.761-.014 3.136 0 .309.207.668.79.555A11.502 11.502 0 0 0 23.5 12C23.5 5.649 18.351.5 12 .5Z")]),
  ])
}

const SectionMount = makeSectionMount("SettingsChangelogSection", Message.MountedSection, () => Message.MountedSection())

export const view = Submodel.defineView<Model, Message, SectionViewInputs>((model, { app, appVersion, switched }, h) => {
  const { status, releases, error } = model
  const updateSnapshot = app.updateSnapshot
  const latestVersion = updateSnapshot?.latestVersion ?? releases[0]?.tag_name ?? "Unknown"
  const currentVersionLabel = updateSnapshot?.currentVersion ?? appVersion
  const isChecking = updateSnapshot?.status === "checking"
  const isUpdating = updateSnapshot?.status === "updating" || updateSnapshot?.status === "restart_pending"
  const canInstallUpdate = updateSnapshot?.updateAvailable === true
  const normalizedLatestVersion = latestVersion.replace(/^v/i, "")
  const normalizedCurrentVersion = currentVersionLabel.replace(/^v/i, "")

  const release = (entry: GithubRelease) => {
    const normalizedTag = entry.tag_name.replace(/^v/i, "")
    const isLatestRelease = normalizedTag === normalizedLatestVersion
    const isCurrentRelease = normalizedTag === normalizedCurrentVersion
    const settings = changelogMarkdown<Message>({
      copyCode: ({ text, block }) => Message.ClickedCopyCode({ releaseId: entry.id, block, text }),
    })
    const copiedBlock = model.copied?.releaseId === entry.id ? model.copied.block : null
    return h.keyed("article")(String(entry.id), [
      h.Class(cn(
        "rounded-2xl border border-border px-4 py-4",
        isLatestRelease ? "bg-muted" : "bg-card/40"
      )),
    ], [
      h.div([h.Class("flex min-w-0 items-center gap-3")], [
        h.div([h.Class("flex min-w-0 flex-1 flex-wrap items-center gap-x-2.5 gap-y-1")], [
          h.h3([h.Class("text-base font-semibold tracking-[-0.2px] text-foreground")], [entry.name?.trim() || entry.tag_name]),
          h.span([h.Class("text-sm text-muted-foreground")], [formatPublishedDate(entry.published_at)]),
          isCurrentRelease ? settingsBadge({}, ["Current"], h) : null,
          entry.prerelease ? settingsBadge({}, ["Prerelease"], h) : null,
        ]),
        h.div([h.Class("flex shrink-0 items-center gap-2")], [
          h.a([
            h.Href(entry.html_url),
            h.Target("_blank"),
            h.Rel("noopener noreferrer"),
            h.AriaLabel("View release on GitHub"),
            h.Class("inline-flex h-8 w-8 items-center justify-center text-muted-foreground transition-colors hover:text-foreground"),
          ], [gitHubIcon("h-4 w-4", h)]),
          isLatestRelease && canInstallUpdate
            ? settingsActionButton({
              prominent: true,
              onClick: Message.ClickedInstallUpdate(),
              disabled: isUpdating,
              icon: DownloadCloud({}, h),
            }, [isUpdating ? "Updating…" : "Update"], h)
            : null,
        ]),
      ]),
      entry.body?.trim()
        ? h.div([h.Class("prose prose-sm mt-4 max-w-none text-foreground dark:prose-invert")], markdown(entry.body, settings, copiedBlock, h))
        : h.div([h.Class("mt-4 text-sm text-muted-foreground")], ["No release notes were provided."]),
    ])
  }

  return sectionContainer({
    sectionId: "changelog",
    switched,
    mount: SectionMount(),
    unmounted: Message.UnmountedSection(),
    label: sectionLabel("changelog"),
    subtitle: sectionSubtitle("changelog"),
  }, [
    h.div([h.Class("space-y-4")], [
      status === "loading" || status === "idle"
        ? settingsPlaceholder({ loading: true }, ["Loading release notes…"], h)
        : null,
      status === "error"
        ? settingsNotice({}, [
          h.div([h.Class("flex items-center justify-between gap-4")], [
            h.div([h.Class("min-w-0")], [
              h.div([h.Class("font-medium")], ["Could not load changelog"]),
              h.div([h.Class("mt-0.5 text-muted-foreground")], [error ?? "Unable to load changelog."]),
            ]),
            settingsActionButton({ onClick: Message.ClickedRetry() }, ["Retry"], h),
          ]),
        ], h)
        : null,
      status === "success" && releases.length === 0
        ? settingsPlaceholder({}, ["GitHub did not return any published releases for this repository."], h)
        : null,
      !canInstallUpdate && status === "success"
        ? h.div([h.Class("flex justify-end")], [
          settingsActionButton({ onClick: Message.ClickedCheckForUpdates(), disabled: isChecking || isUpdating }, [isChecking ? "Checking…" : "Check for updates"], h),
        ])
        : null,
      ...(status === "success" && releases.length > 0 ? releases.map(release) : []),
    ]),
  ], h)
})
