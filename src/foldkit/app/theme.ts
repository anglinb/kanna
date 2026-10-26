import type { AppSettingsSnapshot } from "../../shared/types"

// From src/client/hooks/useTheme.tsx (ThemeProvider): the preference comes
// from app settings, "system" follows prefers-color-scheme, and the
// resolved theme is a class on <html> plus the browser chrome's metadata.

export type ThemePreference = "light" | "dark" | "system"

export function themePreference(settings: AppSettingsSnapshot | null): ThemePreference {
  const theme = settings?.theme
  return theme === "light" || theme === "dark" || theme === "system" ? theme : "system"
}

export function resolveTheme(preference: ThemePreference, systemTheme: "light" | "dark"): "light" | "dark" {
  return preference === "system" ? systemTheme : preference
}

export function getAppleMobileWebAppStatusBarStyle(theme: "light" | "dark") {
  return theme === "dark" ? "black-translucent" : "default"
}

function upsertHeadMeta(name: string, content: string) {
  let tag = document.head.querySelector(`meta[name="${name}"]`)
  if (!tag) {
    tag = document.createElement("meta")
    tag.setAttribute("name", name)
    document.head.appendChild(tag)
  }
  tag.setAttribute("content", content)
}

export function syncThemeMetadata(theme: "light" | "dark") {
  const backgroundColor = getComputedStyle(document.body).backgroundColor || getComputedStyle(document.documentElement).backgroundColor
  if (backgroundColor) {
    upsertHeadMeta("theme-color", backgroundColor)
  }
  upsertHeadMeta("apple-mobile-web-app-status-bar-style", getAppleMobileWebAppStatusBarStyle(theme))
  document.documentElement.style.colorScheme = theme
}
