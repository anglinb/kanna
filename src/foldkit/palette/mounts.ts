import { Mount } from "foldkit"
import { RESTORE_CHAT_INPUT_FOCUS_EVENT } from "../../client/app/chatFocusPolicy"
import { installFocusGuards, installFocusScope } from "../ui/overlay/focus"
import { registerLayer } from "../ui/overlay/layer"
import { hideOthers } from "../ui/overlay/modal"
import { portalToBody } from "../ui/overlay/portal"
import { domStream } from "../ui/overlay/stream"
import { INPUT_ID } from "./cmdk"
import { Message } from "./message"

// The palette's element-owned work: CommandDialog's Radix Dialog content
// (portal, modal layer, focus) and the cmdk root's keydown, which needs the
// live event (IME composition, the input's text selection) and so can't be
// an `OnKeyDown`. Both read what they decide on from the DOM the view keeps
// current (the Back button, the disabled input, the footers), since a
// Mount's args are captured once.

/** The footers' ids: the root's keydown checks which one is up. */
export const COPY_FOOTER_ID = "palette-cmdk-footer-copy"
export const BROWSE_FOOTER_ID = "palette-cmdk-footer-browse"

const backButtonIn = (root: ParentNode) => root.querySelector<HTMLButtonElement>("[cmdk-input-wrapper] > button[aria-label='Back']")
const inputIn = (root: ParentNode) => root.querySelector<HTMLInputElement>(`#${CSS.escape(INPUT_ID)}`)

type ContentMessage = typeof Message.CompletedMountContent.Type | typeof Message.DismissedPalette.Type | typeof Message.PressedBackKey.Type

/**
 * Radix's modal Dialog content without an overlay (CommandDialog renders
 * none): at the end of <body>, everything else aria-hidden and without
 * pointer events, focus trapped and looping, the input focused (it has
 * `autoFocus`). No scroll lock: Radix puts that on the overlay.
 *
 * Escape on a sub-page pops it (CommandDialog's onEscapeKeyDown), and a
 * locked palette (a clone running) ignores Escape and clicks outside, as
 * `handleOpenChange` did.
 */
export const PaletteContent = Mount.defineStream("PaletteContent", {
  messages: [Message.CompletedMountContent, Message.DismissedPalette, Message.PressedBackKey],
  execute: ({ element }) =>
    domStream<ContentMessage>((emit) => {
      const content = element as HTMLElement
      const cleanups: Array<() => void> = []
      cleanups.push(portalToBody(content))
      cleanups.push(registerLayer(content, {
        disableOutsidePointerEvents: true,
        shouldDismiss: ({ reason, event }) => {
          // Radix's modal content prevents focus-outside dismissal.
          if (reason === "focus-outside") return false
          const locked = inputIn(content)?.disabled === true
          if (reason === "escape") {
            if (locked) {
              event.preventDefault()
              return false
            }
            if (backButtonIn(content)) {
              event.preventDefault()
              emit(Message.PressedBackKey())
              return false
            }
            return true
          }
          if (reason === "pointer-down-outside" && event instanceof PointerEvent) {
            const isRightClick = event.button === 2 || (event.button === 0 && event.ctrlKey)
            if (isRightClick) return false
          }
          return !locked
        },
        onDismiss: () => emit(Message.DismissedPalette()),
      }))
      cleanups.push(installFocusScope(content, {
        trapped: true,
        loop: true,
        onMountAutoFocus: () => {
          inputIn(content)?.focus()
          return true
        },
        // CommandDialog's onCloseAutoFocus.
        onUnmountAutoFocus: () => {
          window.dispatchEvent(new Event(RESTORE_CHAT_INPUT_FOCUS_EVENT))
          return true
        },
      }))
      cleanups.push(installFocusGuards(content.ownerDocument))
      cleanups.push(hideOthers(content))
      emit(Message.CompletedMountContent())
      return () => cleanups.reverse().forEach((cleanup) => cleanup())
    }),
})

type RootMessage =
  | typeof Message.CompletedMountRoot.Type
  | typeof Message.PressedNavigationKey.Type
  | typeof Message.PressedEnter.Type
  | typeof Message.PressedBackKey.Type
  | typeof Message.PressedCopyShortcut.Type

/**
 * The `<Command>` root's keydown: the palette's own handler first
 * (Backspace pops a page from an empty input, ⌘↵ opens the browse footer's
 * target, ⌘C copies the highlighted row's path), then cmdk's navigation.
 */
export const PaletteRoot = Mount.defineStream("PaletteRoot", {
  messages: [Message.CompletedMountRoot, Message.PressedNavigationKey, Message.PressedEnter, Message.PressedBackKey, Message.PressedCopyShortcut],
  execute: ({ element }) =>
    domStream<RootMessage>((emit) => {
      const root = element as HTMLElement
      const handleKeyDown = (event: KeyboardEvent) => {
        const document = root.ownerDocument
        const input = inputIn(root)
        const modifier = (event.metaKey || event.ctrlKey) && !event.shiftKey && !event.altKey
        if (event.key === "Backspace" && input && input.value === "" && backButtonIn(root)) {
          event.preventDefault()
          emit(Message.PressedBackKey())
          return
        }
        if (event.key === "Enter" && modifier && document.getElementById(BROWSE_FOOTER_ID)) {
          event.preventDefault()
          emit(Message.PressedEnter({ withModifier: true }))
          return
        }
        if (event.key === "c" && modifier && document.getElementById(COPY_FOOTER_ID)) {
          // Let native copy win when the user has text selected in the input.
          const target = event.target as HTMLInputElement | null
          const hasInputSelection = typeof target?.selectionStart === "number" && target.selectionStart !== target.selectionEnd
          if (hasInputSelection) return
          event.preventDefault()
          emit(Message.PressedCopyShortcut())
          return
        }
        // cmdk's own handler.
        if (event.defaultPrevented || event.isComposing || event.keyCode === 229) return
        const keys = { key: event.key, ctrlKey: event.ctrlKey, metaKey: event.metaKey, altKey: event.altKey }
        switch (event.key) {
          case "n":
          case "j":
          case "p":
          case "k":
            if (!event.ctrlKey) return
            event.preventDefault()
            emit(Message.PressedNavigationKey(keys))
            return
          case "ArrowDown":
          case "ArrowUp":
          case "Home":
          case "End":
            event.preventDefault()
            emit(Message.PressedNavigationKey(keys))
            return
          case "Enter":
            event.preventDefault()
            emit(Message.PressedEnter({ withModifier: modifier }))
            return
        }
      }
      root.addEventListener("keydown", handleKeyDown)
      emit(Message.CompletedMountRoot())
      return () => root.removeEventListener("keydown", handleKeyDown)
    }),
})

/** cmdk's List: `--cmdk-list-height`, the sizer's height, on every resize (a frame later). */
export const PaletteList = Mount.defineStream("PaletteList", {
  messages: [Message.CompletedSideEffect],
  execute: ({ element }) =>
    domStream<typeof Message.CompletedSideEffect.Type>((emit) => {
      const list = element as HTMLElement
      const sizer = list.firstElementChild as HTMLElement | null
      let frame = 0
      const observer = new ResizeObserver(() => {
        frame = requestAnimationFrame(() => {
          if (sizer) list.style.setProperty("--cmdk-list-height", `${sizer.offsetHeight.toFixed(1)}px`)
        })
      })
      if (sizer) observer.observe(sizer)
      emit(Message.CompletedSideEffect())
      return () => {
        cancelAnimationFrame(frame)
        observer.disconnect()
      }
    }),
})
