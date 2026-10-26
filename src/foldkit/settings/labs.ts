import { Schema } from "effect"
import { Submodel } from "foldkit"
import { defineMessageUnion } from "foldkit/message"
import { isNightlyVersion } from "../../shared/types"
import { AppAction } from "../app/action"
import { switchControl } from "../ui/switch"
import { makeSectionMount } from "./activeSection"
import { SETTINGS_ROWS } from "./registry"
import { requestActions, sectionLabel, sectionSubtitle, type AppModel, type SectionReturn, type SectionViewInputs } from "./section"
import { sectionContainer, settingsActionButton, settingsErrorBanner, settingsGroup, settingsRow } from "./shared"

// Settings › Labs (app/settings/LabsSection.tsx).

export const Model = Schema.Struct({
  error: Schema.NullOr(Schema.String),
})
export type Model = typeof Model.Type

export function init(): Model {
  return { error: null }
}

export const Message = defineMessageUnion({
  MountedSection: { onNightly: Schema.Boolean },
  UnmountedSection: {},
  ToggledNewSidebar: { checked: Schema.Boolean },
  ToggledWebglRenderer: { checked: Schema.Boolean },
  ClickedCheckAgain: {},
  ClickedBackToStable: {},
  ClickedBuildLatest: {},
})
export type Message = typeof Message.Type

type Return = SectionReturn<Model, Message>

function currentVersionLabel(app: AppModel, appVersion: string) {
  return app.updateSnapshot?.currentVersion ?? appVersion
}

export function update(model: Model, message: Message, _app: AppModel): Return {
  return Message.match<Return>(message, {
    // On a nightly, the section checks for a newer one as it opens.
    // (React called handleCheckForUpdates() with no options: no `force`.)
    MountedSection: ({ onNightly }) => (onNightly ? requestActions(model, [AppAction.SendCommand({ command: { type: "update.check" } })]) : { model }),
    UnmountedSection: () => ({ model: init() }),
    ToggledNewSidebar: ({ checked }) => requestActions({ ...model, error: null }, [AppAction.WriteAppSettings({ patch: { newSidebarEnabled: checked } })]),
    ToggledWebglRenderer: ({ checked }) => requestActions({ ...model, error: null }, [AppAction.WriteAppSettings({ patch: { terminal: { webglRenderer: checked } } })]),
    ClickedCheckAgain: () => requestActions(model, [AppAction.CheckForUpdates({ force: true })]),
    ClickedBackToStable: () => requestActions(model, [AppAction.InstallStable()]),
    ClickedBuildLatest: () => requestActions(model, [AppAction.InstallNightly()]),
  })
}

const SectionMount = makeSectionMount("SettingsLabsSection", Message.MountedSection, () => Message.MountedSection({ onNightly: false }))
const NightlySectionMount = makeSectionMount("SettingsLabsSectionOnNightly", Message.MountedSection, () => Message.MountedSection({ onNightly: true }))

export const view = Submodel.defineView<Model, Message, SectionViewInputs>((model, { app, appVersion, switched }, h) => {
  const appSettings = app.stores.appSettings.settings
  const updateSnapshot = app.updateSnapshot
  const newSidebarEnabled = appSettings?.newSidebarEnabled !== false
  const webglRendererEnabled = appSettings?.terminal.webglRenderer === true
  const versionLabel = currentVersionLabel(app, appVersion)
  const isUpdating = updateSnapshot?.status === "updating" || updateSnapshot?.status === "restart_pending"
  const onNightly = isNightlyVersion(versionLabel)
  const nightly = updateSnapshot?.nightly
  const nightlyStatusLabel = isUpdating
    ? "Update in progress…"
    : nightly?.status === "up_to_date"
      ? "Latest nightly installed"
      : nightly?.status === "available"
        ? "New nightly available"
        : nightly?.status === "checking"
          ? "Checking latest nightly…"
          : nightly?.status === "error"
            ? "Could not check latest nightly"
            : "Latest nightly not checked yet"

  return sectionContainer({
    sectionId: "labs",
    switched,
    mount: onNightly ? NightlySectionMount() : SectionMount(),
    unmounted: Message.UnmountedSection(),
    label: sectionLabel("labs"),
    subtitle: sectionSubtitle("labs"),
  }, [
    model.error ? settingsErrorBanner(model.error, h) : null,
    settingsGroup({}, [
      settingsRow({
        def: SETTINGS_ROWS.nightlyBuilds,
        wideControl: true,
        ...(onNightly ? { title: `Nightly Build ${versionLabel}` } : {}),
        ...(onNightly
          ? {
            description: [
              h.div([h.Class("flex flex-col gap-1")], [
                h.p([h.Role("status"), h.Class("font-medium text-foreground")], [nightlyStatusLabel]),
                nightly?.latestCommitSha
                  ? h.p([h.Class("whitespace-nowrap")], [
                    "Latest: ",
                    h.code([], [nightly.latestCommitSha.slice(0, 7)]),
                    nightly.lastCheckedAt ? ` as of ${new Date(nightly.lastCheckedAt).toLocaleTimeString()}` : null,
                  ])
                  : nightly?.lastCheckedAt ? h.p([], [`Last checked ${new Date(nightly.lastCheckedAt).toLocaleTimeString()}`]) : null,
                nightly?.error ? h.p([], [nightly.error]) : null,
              ]),
            ],
          }
          : {}),
      }, [
        h.div([h.Class("flex flex-wrap items-center gap-x-4 @2xl:justify-end")], [
          onNightly && nightly?.status !== "available"
            ? settingsActionButton({ onClick: Message.ClickedCheckAgain(), disabled: isUpdating || nightly?.status === "checking" }, ["Check again"], h)
            : null,
          onNightly
            ? settingsActionButton({ onClick: Message.ClickedBackToStable(), disabled: isUpdating }, ["Back to stable"], h)
            : null,
          !onNightly || nightly?.status !== "up_to_date"
            ? settingsActionButton({ onClick: Message.ClickedBuildLatest(), disabled: isUpdating }, [isUpdating ? "Updating…" : "Build latest"], h)
            : null,
        ]),
      ], h),
      settingsRow({ def: SETTINGS_ROWS.recentChatsInSidebar }, [
        switchControl({
          checked: newSidebarEnabled,
          onCheckedChange: (checked) => Message.ToggledNewSidebar({ checked }),
          ariaLabel: SETTINGS_ROWS.recentChatsInSidebar.title,
        }, h),
      ], h),
      settingsRow({ def: SETTINGS_ROWS.terminalWebglRenderer }, [
        switchControl({
          checked: webglRendererEnabled,
          onCheckedChange: (checked) => Message.ToggledWebglRenderer({ checked }),
          ariaLabel: SETTINGS_ROWS.terminalWebglRenderer.title,
        }, h),
      ], h),
    ], h),
  ], h)
})
