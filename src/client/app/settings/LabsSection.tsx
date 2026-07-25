import { useState } from "react"
import { isNightlyVersion } from "../../../shared/types"
import { SegmentedControl } from "../../components/ui/segmented-control"
import { SettingsHeaderButton } from "../../components/ui/settings-header-button"
import type { KannaState } from "../useKannaState"
import { SETTINGS_ROWS } from "./registry"
import { ENABLED_DISABLED_OPTIONS, SettingsErrorBanner, SettingsRow } from "./shared"

export function LabsSection({
  state,
  appVersion,
}: {
  state: Pick<
    KannaState,
    | "appSettings"
    | "handleWriteAppSettings"
    | "updateSnapshot"
    | "handleInstallNightly"
    | "handleInstallStable"
  >
  appVersion: string
}) {
  const { appSettings, handleWriteAppSettings, updateSnapshot } = state
  const [error, setError] = useState<string | null>(null)

  async function handleRecentChatsChange(nextValue: "enabled" | "disabled") {
    try {
      setError(null)
      await handleWriteAppSettings({ newSidebarEnabled: nextValue === "enabled" })
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Unable to save Labs settings.")
    }
  }

  const recentChatsValue = appSettings?.newSidebarEnabled === false ? "disabled" : "enabled"

  const currentVersionLabel = updateSnapshot?.currentVersion ?? appVersion
  const isUpdating = updateSnapshot?.status === "updating" || updateSnapshot?.status === "restart_pending"
  const onNightly = isNightlyVersion(currentVersionLabel)

  return (
    <>
      {error ? <SettingsErrorBanner message={error} /> : null}
      <div className="border-b border-border">
        <SettingsRow def={SETTINGS_ROWS.recentChatsInSidebar} bordered={false}>
          <SegmentedControl
            value={recentChatsValue}
            onValueChange={(value) => {
              void handleRecentChatsChange(value)
            }}
            options={ENABLED_DISABLED_OPTIONS}
            size="sm"
          />
        </SettingsRow>
        <SettingsRow
          def={SETTINGS_ROWS.nightlyBuilds}
          title={onNightly ? `Nightly build ${currentVersionLabel}` : undefined}
          description={
            onNightly
              ? "You're running a build of main. The next published release returns you to stable automatically."
              : undefined
          }
        >
          <div className="flex items-center gap-2">
            {onNightly ? (
              <SettingsHeaderButton
                variant="outline"
                onClick={() => {
                  void state.handleInstallStable()
                }}
                disabled={isUpdating}
              >
                Back to stable
              </SettingsHeaderButton>
            ) : null}
            <SettingsHeaderButton
              variant="outline"
              onClick={() => {
                void state.handleInstallNightly()
              }}
              disabled={isUpdating}
            >
              {isUpdating
                ? "Updating…"
                : onNightly
                  ? "Rebuild latest main"
                  : "Update to nightly"}
            </SettingsHeaderButton>
          </div>
        </SettingsRow>
      </div>
    </>
  )
}
