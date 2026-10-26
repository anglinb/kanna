import type { Html, HtmlBuilder } from "foldkit/html"
import { Compass as CompassNode } from "lucide"
import type { EditorPreset } from "../../shared/protocol"
import type { TerminalPreset } from "../../shared/terminal-presets"
import type { AgentProvider } from "../../shared/types"
import { publicAssetUrl } from "../../client/lib/publicAsset"
import { defineIcon } from "../ui/icon"
import { FolderOpen } from "../ui/icons"
import { PROVIDER_ICONS } from "../ui/provider-icons"

// Icons the palette draws that ui/icons.ts doesn't have: the delegator's
// compass (chat-ui/delegator-icon.tsx) and the "Open in" app icons
// (components/editor-icons.tsx, open-external-menu.tsx's OpenAppIcon).

/** chat-ui/delegator-icon.tsx: Lucide's compass, unaltered. */
export const DelegatorIcon = defineIcon("compass", CompassNode)

/** `PROVIDER_ICONS[provider]` with `className`. */
export function providerIcon<Message>(provider: AgentProvider, className: string | undefined, h: HtmlBuilder<Message>): Html {
  return PROVIDER_ICONS[provider]({ class: className }, h)
}

// APP ICONS (editor-icons.tsx)

const ICON_SRC: Record<EditorPreset | "finder" | "preview" | "defaultApp" | "terminal" | "iterm" | "ghostty", string> = {
  cursor: publicAssetUrl("/editor-icons/cursor.png"),
  vscode: publicAssetUrl("/editor-icons/vscode.png"),
  zed: publicAssetUrl("/editor-icons/zed.png"),
  defaultApp: publicAssetUrl("/editor-icons/default-app.png"),
  finder: publicAssetUrl("/editor-icons/finder.png"),
  preview: publicAssetUrl("/editor-icons/preview.png"),
  xcode: publicAssetUrl("/editor-icons/xcode.png"),
  terminal: publicAssetUrl("/editor-icons/terminal.png"),
  iterm: publicAssetUrl("/editor-icons/iterm.png"),
  ghostty: publicAssetUrl("/editor-icons/ghostty.png"),
  windsurf: publicAssetUrl("/editor-icons/windsurf.png"),
  custom: publicAssetUrl("/editor-icons/custom.png"),
}

function appIcon<Message>(src: string, className: string | undefined, h: HtmlBuilder<Message>): Html {
  return h.img([
    h.Src(src),
    h.Alt(""),
    h.AriaHidden(true),
    h.Draggable(false),
    ...(className ? [h.Class(className)] : []),
  ])
}

/**
 * GitHub's own mark, on the black tile it ships as an app icon, so the forge
 * entry sits in the "Open in…" menus as a peer of the macOS app icons around
 * it rather than as a line-art glyph.
 */
function githubTileIcon<Message>(className: string | undefined, h: HtmlBuilder<Message>): Html {
  return h.svg([
    h.Attribute("viewBox", "0 0 128 128"),
    ...(className ? [h.Class(className)] : []),
    h.Attribute("aria-hidden", "true"),
    h.Attribute("focusable", "false"),
  ], [
    h.rect([h.Attribute("x", "8"), h.Attribute("y", "8"), h.Attribute("width", "112"), h.Attribute("height", "112"), h.Attribute("rx", "25"), h.Attribute("fill", "#1b1f23")]),
    h.path([
      h.Attribute("transform", "translate(28 28) scale(0.0703125)"),
      h.Attribute("fill", "#ffffff"),
      h.Attribute("fill-rule", "evenodd"),
      h.Attribute("clip-rule", "evenodd"),
      h.Attribute("d", "M512 0C229.12 0 0 229.12 0 512c0 226.56 146.56 417.92 350.08 485.76 25.6 4.48 35.2-10.88 35.2-24.32 0-12.16-.64-52.48-.64-95.36-128.64 23.68-161.92-31.36-172.16-60.16-5.76-14.72-30.72-60.16-52.48-72.32-17.92-9.6-43.52-33.28-.64-33.92 40.32-.64 69.12 37.12 78.72 52.48 46.08 77.44 119.68 55.68 149.12 42.24 4.48-33.28 17.92-55.68 32.64-68.48-113.92-12.8-232.96-56.96-232.96-252.8 0-55.68 19.84-101.76 52.48-137.6-5.12-12.8-23.04-65.28 5.12-135.68 0 0 42.88-13.44 140.8 52.48 40.96-11.52 84.48-17.28 128-17.28s87.04 5.76 128 17.28c97.92-66.56 140.8-52.48 140.8-52.48 28.16 70.4 10.24 122.88 5.12 135.68 32.64 35.84 52.48 81.28 52.48 137.6 0 196.48-119.68 240-233.6 252.8 18.56 16 34.56 46.72 34.56 94.72 0 68.48-.64 123.52-.64 140.8 0 13.44 9.6 29.44 35.2 24.32C877.44 929.92 1024 737.92 1024 512 1024 229.12 794.88 0 512 0"),
    ]),
  ])
}

export type OpenAppValue =
  | "finder"
  | "terminal"
  | "preview"
  | "default"
  | "repo"
  | `editor:${EditorPreset}`
  | `terminal:${TerminalPreset}`

function terminalPresetFromValue(value: OpenAppValue) {
  return value.startsWith("terminal:") ? value.slice("terminal:".length) as TerminalPreset : null
}

/** open-external-menu.tsx's `OpenAppIcon`. */
export function openAppIcon<Message>(value: OpenAppValue, isMac: boolean, className: string | undefined, h: HtmlBuilder<Message>): Html {
  if (value === "repo") return githubTileIcon(className, h)
  if (value === "finder") return isMac ? appIcon(ICON_SRC.finder, className, h) : FolderOpen({ class: className }, h)
  if (value === "terminal" || value.startsWith("terminal:")) {
    const preset = terminalPresetFromValue(value)
    const src = preset === "iterm" ? ICON_SRC.iterm : preset === "ghostty" ? ICON_SRC.ghostty : ICON_SRC.terminal
    return appIcon(src, className, h)
  }
  if (value === "preview") return appIcon(ICON_SRC.preview, className, h)
  if (value === "default") return appIcon(ICON_SRC.defaultApp, className, h)
  const preset = value.replace("editor:", "") as EditorPreset
  return appIcon(ICON_SRC[preset] ?? ICON_SRC.cursor, className, h)
}
