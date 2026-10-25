import { Effect, Schema } from "effect"
import { Command } from "foldkit"
import type { MountAction } from "foldkit/mount"
import type { Html, HtmlBuilder } from "foldkit/html"
import { defineMessageUnion } from "foldkit/message"
import { cn } from "../../client/lib/utils"
import type { ChatBrowserNotificationPreference } from "../../shared/types"
import type { Child, ExtraAttributes } from "../ui/attributes"
import { Loader2 } from "../ui/icons"
import * as Select from "../ui/select"
import type { SettingsRowDef } from "./registry"

// Port of src/client/app/settings/shared.tsx: the row layout and the small
// pieces every section draws with. View helpers take the builder last.

/*
 * Every control in a row is an accessory, the way iOS Settings draws them:
 * plain text on the row, with no border, fill or corner of its own. Boxed
 * controls brought their own radii and heights (pill buttons, rounded-lg
 * selects, a framed segmented control) that never agreed with each other or
 * with the card around them. Text has nothing to disagree about, and it fits
 * a phone-width column as well as a wide one.
 *
 * Values sit in muted text and brighten on hover, focus and while open;
 * actions are foreground text. With no box to ring, keyboard focus underlines.
 * The fixed h-9 is invisible: it keeps a finger-sized target and matches the
 * height of the two-line text beside it, so rows don't change height with
 * their control.
 */
const SETTINGS_ACCESSORY_FOCUS_CLASS =
  "outline-none focus-visible:underline focus-visible:decoration-muted-foreground/50 focus-visible:underline-offset-4"

/** A picker's trigger: "Value ⌄", right-aligned against the row's edge. */
const SETTINGS_SELECT_TRIGGER_CLASS = cn(
  "h-9 w-auto max-w-full justify-end gap-1 rounded-none border-0 bg-transparent p-0 text-muted-foreground",
  "hover:text-foreground focus-visible:text-foreground data-[state=open]:text-foreground",
  "focus:ring-0 focus:ring-offset-0 [&>svg]:h-3.5 [&>svg]:w-3.5",
  SETTINGS_ACCESSORY_FOCUS_CLASS,
)

/**
 * Text fields. They sit right-aligned beside the row text once the column is
 * wide and drop under it, left-aligned, when it isn't. The caret and the
 * brighter text are what say "editing" now that there is no frame.
 *
 * Breakpoints here are container queries (`@2xl:`) against the settings
 * column, not the viewport: with the app sidebar open the column can be
 * phone-narrow on a wide window.
 */
const SETTINGS_INPUT_BASE_CLASS = cn(
  "h-9 rounded-none border-0 bg-transparent px-0 py-0 text-muted-foreground placeholder:text-muted-foreground/50",
  "hover:text-foreground focus:text-foreground",
)
export const SETTINGS_CONTROL_CLASS = cn(SETTINGS_INPUT_BASE_CLASS, "w-full @2xl:w-60 @2xl:text-right")
export const SETTINGS_NUMBER_INPUT_CLASS = cn(
  SETTINGS_INPUT_BASE_CLASS,
  "hide-number-steppers w-24 text-left font-mono tabular-nums @2xl:text-right",
)

/**
 * Left/right inset for text that sits on the page above a card (group
 * headings, the section title): 1px card border + the rows' 16px padding, so
 * it lines up with the text inside the cards, the way iOS grouped lists do.
 * Anything that sits under a heading keeps px-4 so this one offset fits all.
 */
export const SETTINGS_INSET_X_CLASS = "px-[17px]"

/**
 * The card rows sit in, with a hairline between rows. overflow-hidden keeps
 * the palette's jump highlight inside the corners.
 */
export const SETTINGS_LIST_CARD_CLASS = "divide-y divide-border overflow-hidden rounded-2xl border border-border bg-card/40"

/** Inline text actions inside a row description ("View tracked events", "Reset to …"). */
export const SETTINGS_INLINE_ACTION_CLASS =
  "font-medium text-foreground underline underline-offset-2 transition-colors hover:text-foreground/70"

export function getKeybindingsSubtitle(filePathDisplay: string) {
  return `Edit global app shortcuts stored in ${filePathDisplay}.`
}

export function shouldPreviewChatSoundChange(
  previousValue: string,
  nextValue: string
) {
  return previousValue !== nextValue
}

/**
 * A browser notification setting only sticks once the permission prompt was
 * granted; otherwise it falls back to "never" so the picker never claims an
 * option the browser will silently ignore.
 */
export function resolveChatBrowserNotificationPreferenceAfterPermission(
  requestedPreference: ChatBrowserNotificationPreference,
  permission: NotificationPermission | "unsupported"
): ChatBrowserNotificationPreference {
  if (requestedPreference === "never") return "never"
  return permission === "granted" ? requestedPreference : "never"
}

// THE SECTION'S CONTENT

export interface SectionContainerOptions<Message> {
  sectionId: string
  /**
   * Picking another section fades its content in, so the swap reads as one
   * page changing rather than a cut. Opening Settings doesn't: that is often
   * ⌘, and a shortcut should land at once.
   */
  switched: boolean
  /** The section's Mount (activeSection.ts), and the Message for it leaving. */
  mount: MountAction<Message>
  unmounted: Message
  label: string
  subtitle: string
  /** On the title's line, right (Keybindings' "Open in …"). */
  action?: Html
}

/**
 * The selected section: its title and subtitle, then its content. Keyed by
 * section, as React keyed it, so a switch puts in a fresh element (and the
 * fade's starting style applies).
 */
export function sectionContainer<Message>(options: SectionContainerOptions<Message>, children: ReadonlyArray<Child>, h: HtmlBuilder<Message>): Html {
  return h.keyed("div")(options.sectionId, [
    h.Class(cn(
      "@container mx-auto max-w-4xl",
      options.switched && "transition-opacity duration-150 ease-snappy starting:opacity-0",
    )),
    h.OnMount(options.mount),
    h.OnUnmount(options.unmounted),
  ], [
    h.div([h.Class(cn("pb-6", SETTINGS_INSET_X_CLASS))], [
      h.div([h.Class("flex items-center justify-between gap-4 min-h-[34px]")], [
        h.div([h.Class("text-lg font-semibold tracking-[-0.2px] text-foreground")], [options.label]),
        options.action ?? null,
      ]),
      h.div([h.Class("mt-1 text-sm text-muted-foreground")], [options.subtitle]),
    ]),
    ...children,
  ])
}

// SELECT

export interface SettingsSelectConfig<ParentMessage> {
  slotId: string
  model: Select.Model
  value: string
  items: ReadonlyArray<Select.SelectItemConfig>
  /** A top-level function (Foldkit runs view-input callbacks by reference). */
  renderItem: (value: string) => ReadonlyArray<Child>
  disabled?: boolean
  ariaLabel?: string
  toParentMessage: (message: Select.Message) => ParentMessage
  /**
   * Inside a <form>, Radix puts a hidden native <select> beside the trigger.
   * `container` is the element both go in (a row's `control`).
   */
  inForm?: boolean
  container?: (children: ReadonlyArray<Html>) => Html
}

/**
 * A select whose trigger is a row accessory. The panel lines up with the
 * trigger's right edge, where the trigger sits, instead of hanging off its
 * left into the row text.
 */
export function settingsSelect<ParentMessage>(config: SettingsSelectConfig<ParentMessage>, h: HtmlBuilder<ParentMessage>): Html {
  const ariaLabel = config.ariaLabel
  const container = config.container
  return h.submodel({
    slotId: config.slotId,
    model: config.model,
    view: Select.view,
    viewInputs: {
      value: config.value,
      items: config.items,
      renderItem: config.renderItem,
      grouped: true,
      align: "end",
      ...(config.disabled ? { disabled: true } : {}),
      ...(config.inForm ? { inForm: true } : {}),
      toView: (render: Select.RenderInfo) => {
        const trigger = Select.selectTrigger(
          {
            class: SETTINGS_SELECT_TRIGGER_CLASS,
            attributes: [...render.trigger, ...(ariaLabel !== undefined ? [h.AriaLabel(ariaLabel)] : [])],
          },
          [render.value],
          render.portal,
          h,
        )
        return container ? container([trigger, render.nativeSelect]) : trigger
      },
    },
    toParentMessage: config.toParentMessage,
  })
}

// ACTION BUTTON

export interface SettingsActionButtonOptions<Message> {
  icon?: Html
  prominent?: boolean
  disabled?: boolean
  class?: string
  type?: "button" | "submit"
  onClick?: Message
  attributes?: ExtraAttributes<Message>
}

/**
 * A row's action ("Check for updates", "Edit models"). `prominent` is for the
 * one action a row is asking you to take, like installing an available
 * update: it takes the brand colour, as a tinted text button does on iOS.
 */
export function settingsActionButton<Message>(options: SettingsActionButtonOptions<Message>, children: ReadonlyArray<Child>, h: HtmlBuilder<Message>): Html {
  return h.button([
    h.Type(options.type ?? "button"),
    h.Class(cn(
      "inline-flex h-9 min-w-0 max-w-full cursor-pointer items-center gap-1.5 whitespace-nowrap text-sm font-medium",
      "touch-manipulation transition-[color,opacity,scale] duration-150 ease-out active:scale-[0.97]",
      "disabled:cursor-default disabled:opacity-50 disabled:active:scale-100 [&_svg]:size-4 [&_svg]:shrink-0",
      options.prominent ? "text-logo hover:text-logo/80" : "text-foreground hover:text-foreground/70",
      SETTINGS_ACCESSORY_FOCUS_CLASS,
      options.class,
    )),
    ...(options.disabled ? [h.Disabled(true)] : []),
    ...(options.onClick !== undefined ? [h.OnClick(options.onClick)] : []),
    ...(options.attributes ?? []),
  ], [
    options.icon ?? null,
    // A narrow row gives the action half the width; a long label ("Update
    // to 0.77.1-dev") ellipsizes instead of spilling over the title.
    h.span([h.Class("truncate")], children),
  ])
}

// NOTICES AND PLACEHOLDERS

/** Errors and warnings shown above or inside a section. */
export function settingsNotice<Message>(options: { tone?: "error" | "warning"; class?: string }, children: ReadonlyArray<Child>, h: HtmlBuilder<Message>): Html {
  const tone = options.tone ?? "error"
  return h.div([
    ...(tone === "error" ? [h.Role("alert")] : []),
    h.Class(cn(
      "whitespace-pre-wrap break-words rounded-lg border px-4 py-3 text-sm",
      tone === "error"
        ? "border-destructive/20 bg-destructive/5 text-destructive"
        : "border-border bg-card/40 text-muted-foreground",
      options.class,
    )),
  ], children)
}

export function settingsErrorBanner<Message>(message: string, h: HtmlBuilder<Message>): Html {
  return settingsNotice({ class: "mb-6" }, [message], h)
}

/** Loading and empty states: the same card everywhere, with an optional spinner. */
export function settingsPlaceholder<Message>(options: { loading?: boolean; class?: string }, children: ReadonlyArray<Child>, h: HtmlBuilder<Message>): Html {
  return h.div([
    h.Class(cn(
      "flex items-center gap-3 rounded-2xl border border-border bg-card/40 px-4 py-6 text-sm text-muted-foreground",
      options.class,
    )),
  ], [
    options.loading ? Loader2({ class: "h-4 w-4 shrink-0 animate-spin" }, h) : null,
    h.div([h.Class("min-w-0")], children),
  ])
}

/** Small pill for states and tags ("Current", "Prerelease", plan names). */
export function settingsBadge<Message>(options: { class?: string }, children: ReadonlyArray<Child>, h: HtmlBuilder<Message>): Html {
  return h.span([
    h.Class(cn("inline-flex shrink-0 items-center rounded-full border border-border px-2 py-0.5 text-[11px] font-medium text-muted-foreground", options.class)),
  ], children)
}

// GROUPS AND ROWS

/**
 * The heading every titled block in settings uses (row groups, Skills'
 * "Installed"). Styled like the sidebar's section labels (SectionHeader in
 * ThreadSections): quiet chrome you scan past, not a second title.
 */
export function settingsGroupHeading<Message>(title: ReadonlyArray<Child>, trailing: Html, h: HtmlBuilder<Message>): Html {
  return h.div([h.Class(cn("flex min-h-5 items-center justify-between gap-3 pb-1.5", SETTINGS_INSET_X_CLASS))], [
    h.h3([h.Class("text-sm text-slate-500 dark:text-slate-400")], title),
    trailing,
  ])
}

/**
 * A titled card of rows. The divider lines come from the group, so a row that
 * renders conditionally (the custom editor template) never leaves a double or
 * missing border behind.
 */
export function settingsGroup<Message>(
  options: { title?: ReadonlyArray<Child>; trailing?: Html; class?: string; key?: string },
  children: ReadonlyArray<Child>,
  h: HtmlBuilder<Message>,
): Html {
  const attributes = options.class !== undefined ? [h.Class(options.class)] : []
  const content = [
    options.title && options.title.length > 0 ? settingsGroupHeading(options.title, options.trailing ?? null, h) : null,
    h.div([h.Class(SETTINGS_LIST_CARD_CLASS)], children),
  ]
  return options.key !== undefined ? h.keyed("section")(options.key, attributes, content) : h.section(attributes, content)
}

/** Stacks groups with one rhythm across every section. */
export function settingsGroups<Message>(children: ReadonlyArray<Child>, h: HtmlBuilder<Message>): Html {
  return h.div([h.Class("space-y-8")], children)
}

/**
 * An input with the hint line under it ("1000–100000 lines (default)"). Its
 * row takes `wideControl`: with the hint the field is two lines tall, too tall
 * to sit on the title's line, so while the column is narrow it goes under the
 * description, left-aligned. No gap: the h-9 field already leaves air under
 * its text.
 */
export function settingsField<Message>(hint: ReadonlyArray<Child> | null, children: ReadonlyArray<Child>, h: HtmlBuilder<Message>): Html {
  return h.div([h.Class("flex w-full min-w-0 flex-col items-stretch @2xl:w-auto @2xl:items-end")], [
    ...children,
    hint ? h.div([h.Class("text-left text-xs text-muted-foreground/80 @2xl:text-right")], hint) : null,
  ])
}

export interface SettingsRowOptions {
  /** Registry def: provides the anchor id (palette jump target) + title/description. */
  def?: SettingsRowDef
  title?: string
  /**
   * Overrides `def.description` when the rendered description is dynamic
   * markup. `null` shows no subtitle; the def's description still feeds
   * palette search.
   */
  description?: ReadonlyArray<Child> | null
  /** A logo before the title (the provider rows). Spaced like the Accounts rows so their names line up. */
  icon?: Html
  alignStart?: boolean
  /** Indents a row that only exists because of the row above it. */
  nested?: boolean
  /**
   * For controls too wide to share a line with the title (text fields, the
   * provider pickers): below the breakpoint they get their own full-width
   * line under the description. See settingsRow for both layouts.
   */
  wideControl?: boolean
  /** A key for the row among its siblings (React's `key`). */
  key?: string
  /**
   * A control that builds its own container (a select in a form puts a
   * hidden native select beside its trigger): it gets the function that
   * wraps children in the row's control cell, and `children` is ignored.
   */
  control?: (wrap: (children: ReadonlyArray<Child>) => Html) => Html
}

export function settingsRow<Message>(options: SettingsRowOptions, children: ReadonlyArray<Child>, h: HtmlBuilder<Message>): Html {
  const def = options.def
  const resolvedDescription: ReadonlyArray<Child> | null = options.description === undefined
    ? (def?.description ? [def.description] : null)
    : options.description
  const hasDescription = resolvedDescription !== null && resolvedDescription.some((child) => child !== null && child !== "")
  /*
   * Two layouts on one grid, switched at the column's @2xl breakpoint.
   *
   * Wide: text on the left, control on the right, centred on the text.
   *
   *   Title        [control]
   *   Description  [control]
   *
   * Narrow: beside the text, the control squeezed the description into a
   * thin column of two-word lines. Instead a small control shares the title's
   * line and the description takes the full width under both. A wide control
   * has no room on that line, so it gets its own full-width line last.
   *
   *   Title   [control]        Title
   *   Description.........     Description.........
   *                            [wide control.......]
   *
   * Spacing is margins, not gap, so an empty description row adds nothing.
   */
  const wrapControl = (controlChildren: ReadonlyArray<Child>) => h.div([
    h.Class(cn(
      "flex min-w-0 items-center self-center",
      options.wideControl
        ? "col-[1/-1] row-[3] mt-2 justify-start @2xl:col-[2] @2xl:mt-0 @2xl:justify-end"
        // The control is h-9 but the title line is h-5: the negative
        // margin lets it centre on the title without pushing the
        // description down.
        : "col-[2] row-[1] -my-2 max-w-[50cqw] justify-end @2xl:my-0",
      hasDescription ? "@2xl:row-[1/3]" : "@2xl:row-[1]",
      options.alignStart && "@2xl:self-start",
    )),
  ], controlChildren)
  const attributes = [
    ...(def ? [h.Id(def.id), h.DataAttribute("settings-row", "")] : []),
    h.Class("scroll-mt-4 px-4"),
  ]
  const content = [
    h.div([
      h.Class(cn(
        "grid grid-cols-[minmax(0,1fr)_auto] gap-x-4 py-2.5 @2xl:gap-x-8",
        options.nested && "pl-6",
      )),
    ], [
      h.div([h.Class("col-[1] row-[1] flex min-w-0 items-center gap-3 self-center text-sm font-medium text-foreground @2xl:max-w-xl")], [
        options.icon ?? null,
        h.span([h.Class("min-w-0")], [options.title ?? def?.title ?? ""]),
      ]),
      hasDescription
        ? h.div([h.Class("col-[1/-1] row-[2] mt-0.5 text-[13px] leading-5 text-muted-foreground @2xl:col-[1] @2xl:max-w-xl")], resolvedDescription ?? [])
        : null,
      options.control ? options.control(wrapControl) : wrapControl(children),
    ]),
  ]
  return options.key !== undefined ? h.keyed("div")(options.key, attributes, content) : h.div(attributes, content)
}

// INPUTS

/**
 * handleSettingsInputKeyDown: Enter commits and blurs the field (whose blur
 * commits again, as React's onBlur did). `BlurActiveElement` does the blur.
 */
export const BlurMessage = defineMessageUnion({
  CompletedBlurActiveElement: {},
})

export const BlurActiveElement = Command.define("BlurActiveElement", {
  messages: [BlurMessage.CompletedBlurActiveElement],
  execute: Effect.sync(() => {
    const active = document.activeElement
    if (active instanceof HTMLElement) active.blur()
    return BlurMessage.CompletedBlurActiveElement()
  }),
})

/** Draft text for a field mirroring a stored value: kept while the value it was typed against still holds. */
export const Draft = Schema.Struct({ text: Schema.String, base: Schema.String })
export type Draft = typeof Draft.Type

export function draftText(draft: Draft | null, current: string) {
  return draft && draft.base === current ? draft.text : current
}
