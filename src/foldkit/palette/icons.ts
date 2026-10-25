import type { Html, HtmlBuilder } from "foldkit/html"
import { Compass as CompassNode } from "lucide"
import type { EditorPreset } from "../../shared/protocol"
import type { TerminalPreset } from "../../shared/terminal-presets"
import type { AgentProvider } from "../../shared/types"
import { publicAssetUrl } from "../../client/lib/publicAsset"
import { cn } from "../../client/lib/utils"
import { defineIcon } from "../ui/icon"
import { FolderOpen } from "../ui/icons"

// Icons the palette draws that ui/icons.ts doesn't have: the harness marks
// (components/provider-icons.tsx), the delegator's compass
// (chat-ui/delegator-icon.tsx) and the "Open in" app icons
// (components/editor-icons.tsx).

/** chat-ui/delegator-icon.tsx: Lucide's compass, unaltered. */
export const DelegatorIcon = defineIcon("compass", CompassNode)

// PROVIDER ICONS

interface SvgIconData {
  viewBox: string
  fillRule?: string
  focusable?: string
  paths: ReadonlyArray<{ d: string; fillRule?: string; clipRule?: string }>
}

const PROVIDER_ICON_DATA: Record<"Anthropic" | "OpenAI" | "Cursor" | "Grok" | "Pi", SvgIconData> = {
  Anthropic: { viewBox: "0 0 100 100", paths: [{"d":"m19.6 66.5 19.7-11 .3-1-.3-.5h-1l-3.3-.2-11.2-.3L14 53l-9.5-.5-2.4-.5L0 49l.2-1.5 2-1.3 2.9.2 6.3.5 9.5.6 6.9.4L38 49.1h1.6l.2-.7-.5-.4-.4-.4L29 41l-10.6-7-5.6-4.1-3-2-1.5-2-.6-4.2 2.7-3 3.7.3.9.2 3.7 2.9 8 6.1L37 36l1.5 1.2.6-.4.1-.3-.7-1.1L33 25l-6-10.4-2.7-4.3-.7-2.6c-.3-1-.4-2-.4-3l3-4.2L28 0l4.2.6L33.8 2l2.6 6 4.1 9.3L47 29.9l2 3.8 1 3.4.3 1h.7v-.5l.5-7.2 1-8.7 1-11.2.3-3.2 1.6-3.8 3-2L61 2.6l2 2.9-.3 1.8-1.1 7.7L59 27.1l-1.5 8.2h.9l1-1.1 4.1-5.4 6.9-8.6 3-3.5L77 13l2.3-1.8h4.3l3.1 4.7-1.4 4.9-4.4 5.6-3.7 4.7-5.3 7.1-3.2 5.7.3.4h.7l12-2.6 6.4-1.1 7.6-1.3 3.5 1.6.4 1.6-1.4 3.4-8.2 2-9.6 2-14.3 3.3-.2.1.2.3 6.4.6 2.8.2h6.8l12.6 1 3.3 2 1.9 2.7-.3 2-5.1 2.6-6.8-1.6-16-3.8-5.4-1.3h-.8v.4l4.6 4.5 8.3 7.5L89 80.1l.5 2.4-1.3 2-1.4-.2-9.2-7-3.6-3-8-6.8h-.5v.7l1.8 2.7 9.8 14.7.5 4.5-.7 1.4-2.6 1-2.7-.6-5.8-8-6-9-4.7-8.2-.5.4-2.9 30.2-1.3 1.5-3 1.2-2.5-2-1.4-3 1.4-6.2 1.6-8 1.3-6.4 1.2-7.9.7-2.6v-.2H49L43 72l-9 12.3-7.2 7.6-1.7.7-3-1.5.3-2.8L24 86l10-12.8 6-7.9 4-4.6-.1-.5h-.3L17.2 77.4l-4.7.6-2-2 .2-3 1-1 8-5.5Z"}] },
  OpenAI: { viewBox: "0 0 158.7128 157.296", paths: [{"d":"M60.8734 57.2556V42.3124c0-1.2586.4722-2.2029 1.5728-2.8314l30.0443-17.3023c4.0899-2.3593 8.9662-3.4599 13.9988-3.4599 18.8759 0 30.8307 14.6289 30.8307 30.2006 0 1.1007 0 2.3593-.158 3.6178l-31.1446-18.2467c-1.8872-1.1006-3.7754-1.1006-5.6629 0L60.8734 57.2556Zm70.1542 58.2005V79.7487c0-2.2028-.9446-3.7756-2.8318-4.8763l-39.481-22.9651 12.8982-7.3934c1.1007-.6285 2.0453-.6285 3.1458 0l30.0441 17.3024c8.6523 5.0341 14.4708 15.7296 14.4708 26.1107 0 11.9539-7.0769 22.965-18.2461 27.527ZM51.593 83.9964l-12.8982-7.5497c-1.1007-.6285-1.5728-1.5728-1.5728-2.8314V39.0105c0-16.8303 12.8982-29.5722 30.3585-29.5722 6.607 0 12.7403 2.2029 17.9324 6.1349l-30.987 17.9324c-1.8871 1.1007-2.8314 2.6735-2.8314 4.8764v45.6159ZM79.3562 100.0403 60.8733 89.6592V67.6383l18.4829-10.3811 18.4812 10.3811v22.0209l-18.4812 10.3811Zm11.8757 47.8188c-6.607 0-12.7403-2.2031-17.9324-6.1344l30.9866-17.9333c1.8872-1.1005 2.8318-2.6728 2.8318-4.8759v-45.616l13.0564 7.5498c1.1005.6285 1.5723 1.5728 1.5723 2.8314v34.6051c0 16.8297-13.0564 29.5723-30.5147 29.5723ZM53.9522 112.7822 23.9079 95.4798c-8.652-5.0343-14.471-15.7296-14.471-26.1107 0-12.1119 7.2356-22.9652 18.403-27.5272v35.8634c0 2.2028.9443 3.7756 2.8314 4.8763l39.3248 22.8068-12.8982 7.3938c-1.1007.6287-2.045.6287-3.1456 0ZM52.2229 138.5791c-17.7745 0-30.8306-13.3713-30.8306-29.8871 0-1.2585.1578-2.5169.3143-3.7754l30.987 17.9323c1.8871 1.1005 3.7757 1.1005 5.6628 0l39.4811-22.807v14.9435c0 1.2585-.4721 2.2021-1.5728 2.8308l-30.0443 17.3025c-4.0898 2.359-8.9662 3.4605-13.9989 3.4605h.0014ZM91.2319 157.296c19.0327 0 34.9188-13.5272 38.5383-31.4594 17.6164-4.562 28.9425-21.0779 28.9425-37.908 0-11.0112-4.719-21.7066-13.2133-29.4143.7867-3.3035 1.2595-6.607 1.2595-9.909 0-22.4929-18.2471-39.3247-39.3251-39.3247-4.2461 0-8.3363.6285-12.4262 2.045-7.0792-6.9213-16.8318-11.3254-27.5271-11.3254-19.0331 0-34.9191 13.5268-38.5384 31.4591C11.3255 36.0212 0 52.5373 0 69.3675c0 11.0112 4.7184 21.7065 13.2125 29.4142-.7865 3.3035-1.2586 6.6067-1.2586 9.9092 0 22.4923 18.2466 39.3241 39.3248 39.3241 4.2462 0 8.3362-.6277 12.426-2.0441 7.0776 6.921 16.8302 11.3251 27.5271 11.3251Z"}] },
  Cursor: { viewBox: "0 0 747 851", paths: [{"d":"M731.545 201.413L390.888 4.73778C379.949 -1.57926 366.452 -1.57926 355.513 4.73778L14.8731 201.413C5.67749 206.723 0.00012207 216.542 0.00012207 227.177V623.776C0.00012207 634.394 5.67749 644.23 14.8731 649.539L355.529 846.214C366.468 852.532 379.966 852.532 390.905 846.214L731.56 649.539C740.756 644.23 746.434 634.409 746.434 623.776V227.177C746.434 216.558 740.756 206.723 731.56 201.413H731.545ZM710.147 243.074L381.293 812.663C379.07 816.501 373.201 814.933 373.201 810.487V437.526C373.201 430.074 369.218 423.18 362.757 419.438L39.7735 232.966C35.9353 230.744 37.5026 224.874 41.9484 224.874H699.655C708.996 224.874 714.833 234.997 710.162 243.09H710.147V243.074Z"}] },
  Grok: { viewBox: "0 0 24 24", fillRule: "evenodd", paths: [{"d":"M9.27 15.29l7.978-5.897c.391-.29.95-.177 1.137.272.98 2.369.542 5.215-1.41 7.169-1.951 1.954-4.667 2.382-7.149 1.406l-2.711 1.257c3.889 2.661 8.611 2.003 11.562-.953 2.341-2.344 3.066-5.539 2.388-8.42l.006.007c-.983-4.232.242-5.924 2.75-9.383.06-.082.12-.164.179-.248l-3.301 3.305v-.01L9.267 15.292M7.623 16.723c-2.792-2.67-2.31-6.801.071-9.184 1.761-1.763 4.647-2.483 7.166-1.425l2.705-1.25a7.808 7.808 0 00-1.829-1A8.975 8.975 0 005.984 5.83c-2.533 2.536-3.33 6.436-1.962 9.764 1.022 2.487-.653 4.246-2.34 6.022-.599.63-1.199 1.259-1.682 1.925l7.62-6.815"}] },
  Pi: { viewBox: "-10 -10 84 84", focusable: "false", paths: [{"d":"M0 0H47.9997V31.9993H31.9993V47.9997H16.0003V64H0V0ZM16.0003 16.0003V31.9993H31.9993V16.0003H16.0003Z","fillRule":"evenodd","clipRule":"evenodd"},{"d":"M47.9997 31.9993H64V64H47.9997V31.9993Z"}] },
}

function svgIcon<Message>(data: SvgIconData, className: string | undefined, h: HtmlBuilder<Message>): Html {
  return h.svg([
    h.Attribute("viewBox", data.viewBox),
    h.Attribute("fill", "currentColor"),
    ...(data.fillRule ? [h.Attribute("fill-rule", data.fillRule)] : []),
    h.Attribute("aria-hidden", "true"),
    ...(data.focusable ? [h.Attribute("focusable", data.focusable)] : []),
    h.Class(cn("shrink-0", className)),
  ], data.paths.map((path) => h.path([
    ...(path.fillRule ? [h.Attribute("fill-rule", path.fillRule)] : []),
    ...(path.clipRule ? [h.Attribute("clip-rule", path.clipRule)] : []),
    h.Attribute("d", path.d),
  ])))
}

const PROVIDER_ICON_NAMES: Record<AgentProvider, keyof typeof PROVIDER_ICON_DATA> = {
  claude: "Anthropic",
  codex: "OpenAI",
  cursor: "Cursor",
  grok: "Grok",
  pi: "Pi",
}

/** `PROVIDER_ICONS[provider]` with `className`. */
export function providerIcon<Message>(provider: AgentProvider, className: string | undefined, h: HtmlBuilder<Message>): Html {
  return svgIcon(PROVIDER_ICON_DATA[PROVIDER_ICON_NAMES[provider]], className, h)
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
