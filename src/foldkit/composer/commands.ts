import { Effect, Schema } from "effect"
import { Command, Render } from "foldkit"
import { focusNextChatInput } from "../../client/app/chatFocusPolicy"
import { copyTextToClipboard } from "../../client/lib/clipboard"
import { buildUploadErrorReport } from "../../client/lib/uploadError"
import { generateUUID } from "../../client/lib/utils"
import type { ChatAttachment, ChatSkillsSnapshot } from "../../shared/types"
import { opaque } from "../core/schema"
import { errorMessage, sendCommand } from "../core/socket"
import * as ChatInput from "../core/stores/chatInput"
import { Message } from "./message"
import { AgentProviderSchema, FileSchema } from "./model"
import * as Recorder from "./recorder"

// Every side effect the composer has, as Commands. Elements are found by the
// composer's `data-composer` id (textareaSelector), as React held refs.

export const textareaSelector = (domId: string) => `textarea[data-composer="${domId}"]`
export const fileInputSelector = (domId: string, which: "palette" | "attach") => `input[data-composer-file="${domId}-${which}"]`
export const holdArcSelector = (domId: string) => `[data-hold-arc="${domId}"]`

function textareaOf(domId: string) {
  return document.querySelector<HTMLTextAreaElement>(textareaSelector(domId))
}

/** autoResize, after the patch that put the new text in. */
export const AutoResize = Command.define("AutoResizeComposer", {
  args: { domId: Schema.String },
  messages: [Message.CompletedSideEffect],
  execute: ({ domId }) => Effect.gen(function* () {
    yield* Render.afterCommit
    const element = textareaOf(domId)
    if (element) {
      if (element.value.length === 0) {
        element.style.height = ""
      } else {
        element.style.height = "auto"
        element.style.height = `${element.scrollHeight}px`
      }
    }
    return Message.CompletedSideEffect()
  }),
})

/** After a submit: `textareaRef.current.style.height = "auto"`. */
export const ResetHeight = Command.define("ResetComposerHeight", {
  args: { domId: Schema.String },
  messages: [Message.CompletedSideEffect],
  execute: ({ domId }) => Effect.sync(() => {
    const element = textareaOf(domId)
    if (element) element.style.height = "auto"
    return Message.CompletedSideEffect()
  }),
})

/** The caret where a completion left it, focused (the requestAnimationFrame after setValue). */
export const PlaceCaret = Command.define("PlaceComposerCaret", {
  args: { domId: Schema.String, caret: Schema.Number, focus: Schema.Boolean },
  messages: [Message.CompletedSideEffect],
  execute: ({ domId, caret, focus }) => Effect.gen(function* () {
    yield* Render.afterCommit
    const element = textareaOf(domId)
    if (element) {
      if (focus) element.focus()
      element.selectionStart = caret
      element.selectionEnd = caret
    }
    return Message.CompletedSideEffect()
  }),
})

export const FocusTextarea = Command.define("FocusComposer", {
  args: { domId: Schema.String },
  messages: [Message.CompletedSideEffect],
  execute: ({ domId }) => Effect.gen(function* () {
    yield* Render.afterCommit
    textareaOf(domId)?.focus({ preventScroll: true })
    return Message.CompletedSideEffect()
  }),
})

export const FocusNextChatInput = Command.define("FocusNextChatInput", {
  args: { domId: Schema.String },
  messages: [Message.CompletedSideEffect],
  execute: ({ domId }) => Effect.sync(() => {
    focusNextChatInput(textareaOf(domId), document)
    return Message.CompletedSideEffect()
  }),
})

export const ClearFileInput = Command.define("ClearComposerFileInput", {
  args: { selector: Schema.String },
  messages: [Message.CompletedSideEffect],
  execute: ({ selector }) => Effect.sync(() => {
    const input = document.querySelector<HTMLInputElement>(selector)
    if (input) input.value = ""
    return Message.CompletedSideEffect()
  }),
})

/** onListSkills: the selected harness's invocable skills, for the "/" menu. */
export const ListSkills = Command.define("ListSkills", {
  args: { provider: AgentProviderSchema, chatId: Schema.NullOr(Schema.String), projectId: Schema.NullOr(Schema.String) },
  messages: [Message.SucceededListSkills, Message.FailedListSkills],
  execute: ({ provider, chatId, projectId }) => sendCommand<ChatSkillsSnapshot>({
    type: "chat.listSkills",
    provider,
    chatId: chatId ?? undefined,
    projectId: projectId ?? undefined,
  }).pipe(
    Effect.map((snapshot) => Message.SucceededListSkills({ provider: snapshot.provider, skills: snapshot.skills })),
    Effect.catch(() => Effect.succeed(Message.FailedListSkills())),
  ),
})

/**
 * The file's place in the row, before its bytes go. Not crypto.randomUUID():
 * that is secure-context only, so it is undefined when Kanna is opened over
 * plain http on a LAN/Tailscale hostname, and every upload would throw
 * before it started.
 */
export const StartUpload = Command.define("StartUpload", {
  args: { file: FileSchema, generation: Schema.Number },
  messages: [Message.StartedUpload],
  execute: ({ file, generation }) => Effect.sync(() => Message.StartedUpload({
    tempId: generateUUID(),
    file,
    previewUrl: file.type.startsWith("image/") ? URL.createObjectURL(file) : null,
    generation,
  })),
})

export const Upload = Command.define("UploadAttachment", {
  args: { tempId: Schema.String, file: FileSchema, projectId: Schema.String, generation: Schema.Number },
  messages: [Message.SucceededUpload, Message.FailedUpload],
  execute: ({ tempId, file, projectId, generation }) => Effect.promise(async () => {
    const requestUrl = `/api/projects/${projectId}/uploads`
    const startedAt = Date.now()
    let stage = "request"
    let responseStatus: number | null = null
    let responseStatusText = ""
    let responseBody = ""
    try {
      const formData = new FormData()
      formData.append("files", file)
      // The server compares this against the bytes it actually received, so
      // a body truncated in transit reports itself instead of looking like
      // a parse error.
      formData.append("clientFileSizes", String(file.size))

      const response = await fetch(requestUrl, { method: "POST", body: formData })

      stage = "read-body"
      responseStatus = response.status
      responseStatusText = response.statusText
      // Read once as text. An error page is often not JSON, and the raw
      // body is the only clue when it is not.
      responseBody = await response.text()
      stage = "response"

      if (!response.ok) {
        throw new Error(`The server returned ${response.status}.`)
      }

      const payload = JSON.parse(responseBody) as { attachments: ChatAttachment[] }
      const uploaded = payload.attachments[0]
      if (!uploaded) {
        throw new Error("The server saved nothing and returned no attachment.")
      }
      return Message.SucceededUpload({ tempId, attachment: uploaded, generation })
    } catch (error) {
      return Message.FailedUpload({
        tempId,
        generation,
        report: buildUploadErrorReport({
          file: { name: file.name, size: file.size, type: file.type },
          projectId,
          requestUrl,
          stage,
          durationMs: Date.now() - startedAt,
          responseStatus,
          responseStatusText,
          responseBody,
          error,
          userAgent: navigator.userAgent,
          timestamp: new Date().toISOString(),
        }),
      })
    }
  }),
})

/** An upload nobody wants any more: removed, or from a composer that has moved on. */
export const DeleteUploaded = Command.define("DeleteUploadedAttachment", {
  args: { contentUrl: Schema.String },
  messages: [Message.CompletedSideEffect],
  execute: ({ contentUrl }) => Effect.promise(async () => {
    if (contentUrl) {
      const deleteUrl = contentUrl.replace(/\/content$/, "")
      await fetch(deleteUrl, { method: "DELETE" }).catch(() => undefined)
    }
    return Message.CompletedSideEffect()
  }),
})

export const RevokePreviews = Command.define("RevokeAttachmentPreviews", {
  args: { urls: Schema.Array(Schema.String) },
  messages: [Message.CompletedSideEffect],
  execute: ({ urls }) => Effect.sync(() => {
    urls.forEach((url) => URL.revokeObjectURL(url))
    return Message.CompletedSideEffect()
  }),
})

export const OpenInNewTab = Command.define("OpenAttachmentInNewTab", {
  args: { url: Schema.String },
  messages: [Message.CompletedSideEffect],
  execute: ({ url }) => Effect.sync(() => {
    window.open(new URL(url, window.location.origin).toString(), "_blank", "noopener,noreferrer")
    return Message.CompletedSideEffect()
  }),
})

export const CopyUploadError = Command.define("CopyUploadError", {
  args: { detail: Schema.String },
  messages: [Message.CopiedUploadError],
  execute: ({ detail }) => Effect.promise(() => copyTextToClipboard(detail)).pipe(
    Effect.map((copied) => Message.CopiedUploadError({ copied })),
  ),
})

export const DelayCopied = Command.define("DelayUploadErrorCopied", {
  args: { version: Schema.Number },
  messages: [Message.ElapsedCopied],
  execute: ({ version }) => Effect.sleep(2000).pipe(Effect.as(Message.ElapsedCopied({ version }))),
})

// THE RECORDER

export const StartRecording = Command.define("StartVoiceRecording", {
  args: { key: Schema.String },
  messages: [Message.StartedRecording, Message.FailedStartRecording],
  execute: ({ key }) => Effect.promise(() => Recorder.startRecording(key)).pipe(
    Effect.map((error) => (error === null ? Message.StartedRecording() : Message.FailedStartRecording({ error }))),
  ),
})

export const FinishRecording = Command.define("FinishVoiceRecording", {
  args: { key: Schema.String },
  messages: [Message.FinishedRecording],
  execute: ({ key }) => Effect.promise(() => Recorder.finishRecording(key)).pipe(
    Effect.map(({ recording, error }) => Message.FinishedRecording({ recording, error })),
  ),
})

export const CancelRecording = Command.define("CancelVoiceRecording", {
  args: { key: Schema.String },
  messages: [Message.CompletedSideEffect],
  execute: ({ key }) => Effect.sync(() => {
    Recorder.cancelRecording(key)
    return Message.CompletedSideEffect()
  }),
})

/**
 * Same flow as the iOS app: POST the raw audio to /api/transcribe; the
 * transcript then goes the normal send path, which queues when a turn is
 * already running, the same as Enter.
 */
export const Transcribe = Command.define("TranscribeRecording", {
  args: { recording: opaque<Recorder.VoiceRecording>("VoiceRecording") },
  messages: [Message.TranscribedRecording, Message.FailedTranscribe],
  execute: ({ recording }) => Effect.promise(async () => {
    try {
      const response = await fetch("/api/transcribe", {
        method: "POST",
        headers: { "Content-Type": recording.mimeType },
        body: recording.blob,
      })
      if (!response.ok) {
        const envelope = (await response.json().catch(() => null)) as { error?: { message?: string } } | null
        throw new Error(envelope?.error?.message || "Transcription failed. Try again.")
      }
      const payload = (await response.json()) as { text?: string }
      return Message.TranscribedRecording({ text: (payload.text ?? "").trim() })
    } catch (error) {
      return Message.FailedTranscribe({ error: error instanceof Error ? error.message : "Transcription failed. Try again." })
    }
  }),
})

/**
 * Focus back in the composer after a discarded recording, on the next frame
 * (the textarea is back by then).
 */
export const RefocusAfterDiscard = Command.define("RefocusComposerAfterDiscard", {
  args: { domId: Schema.String },
  messages: [Message.CompletedSideEffect],
  execute: ({ domId }) => Effect.gen(function* () {
    yield* Render.afterCommit
    yield* Effect.callback<void>((resume) => {
      window.requestAnimationFrame(() => resume(Effect.void))
    })
    textareaOf(domId)?.focus({ preventScroll: true })
    return Message.CompletedSideEffect()
  }),
})

// HOLD TO STOP

/** The ring's way back when the key is let go. Matches the transition on the ring. */
export const RELEASE_MS = 120
/** How long the hint stays after a tap. */
export const HINT_LINGER_MS = 1000
/** How long a closed ring waits for the turn to be seen to stop. */
export const CONFIRMED_LINGER_MS = 2500

export const DelayHoldStep = Command.define("DelayHoldStep", {
  args: { version: Schema.Number, step: Schema.Literals(["ring", "hint", "confirmed"]), ms: Schema.Number },
  messages: [Message.ElapsedHoldTimer],
  execute: ({ version, step, ms }) => Effect.sleep(ms).pipe(Effect.as(Message.ElapsedHoldTimer({ version, step }))),
})

/** The ring back to empty: over the release transition, or at once. */
export function emptyRing(domId: string, instant: boolean) {
  const arc = document.querySelector<SVGCircleElement>(holdArcSelector(domId))
  if (!arc) return
  // Inline `none` is what a hold draws under; cleared, the class's
  // transition takes over and runs back from the value last drawn.
  arc.style.transition = instant ? "none" : ""
  arc.style.strokeDashoffset = "1"
}

export const EmptyRing = Command.define("EmptyHoldRing", {
  args: { domId: Schema.String, instant: Schema.Boolean },
  messages: [Message.CompletedSideEffect],
  execute: ({ domId, instant }) => Effect.sync(() => {
    emptyRing(domId, instant)
    return Message.CompletedSideEffect()
  }),
})

// DELEGATORS (create-delegator.ts)

/**
 * Creates the delegator empty, then names it if it was given a name. Left
 * blank it is "New Chat" until its first message names it, as any chat is.
 */
export const CreateDelegator = Command.define("CreateDelegator", {
  args: { projectId: Schema.String, name: Schema.String },
  messages: [Message.SucceededCreateDelegator, Message.FailedCreateDelegator],
  execute: ({ projectId, name }) => Effect.gen(function* () {
    const { chatId } = yield* sendCommand<{ chatId: string }>({ type: "chat.create", projectId, delegator: true })
    if (name) yield* sendCommand({ type: "chat.rename", chatId, title: name })
    return Message.SucceededCreateDelegator({ projectId, chatId })
  }).pipe(
    Effect.catch((error) => Effect.succeed(Message.FailedCreateDelegator({ error: errorMessage(error) }))),
  ),
})

// SENDING

/**
 * The draft leaves the store behind the send. React cleared it in the
 * same tick as the send, and the server heard of the change (draft
 * protection) from an effect after the render; here the clear itself waits
 * for the render, so the send is out first either way.
 */
export const ClearDraftAfterSend = Command.define("ClearComposerDraftAfterSend", {
  args: { draftId: Schema.String },
  messages: [Message.ClearedDraftAfterSend],
  execute: ({ draftId }) => Effect.gen(function* () {
    yield* Render.afterCommit
    return Message.ClearedDraftAfterSend({ draftId })
  }),
})

// THE MENUS

/** The highlighted row into view (selectedSkillItemRef.scrollIntoView), once it is drawn. */
export const RevealSelected = Command.define("RevealComposerMenuSelection", {
  args: { domId: Schema.String },
  messages: [Message.CompletedSideEffect],
  execute: ({ domId }) => Effect.gen(function* () {
    yield* Render.afterCommit
    const box = textareaOf(domId)?.parentElement?.parentElement
    box?.querySelector<HTMLElement>("[role=listbox] [aria-selected=true]")?.scrollIntoView({ block: "nearest" })
    return Message.CompletedSideEffect()
  }),
})

// PLUMBING

const toStoreMessage = (message: ChatInput.Message) => Message.GotChatInputStoreMessage({ message })

export const changeDraft = (chatId: string, value: string) =>
  Command.mapMessage(ChatInput.ChangeDraft({ chatId, value }), toStoreMessage)

export const changeAttachmentDrafts = (chatId: string, attachments: ReadonlyArray<ChatAttachment>) =>
  Command.mapMessage(ChatInput.ChangeAttachmentDrafts({ chatId, attachments }), toStoreMessage)
