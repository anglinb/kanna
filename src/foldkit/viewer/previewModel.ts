import { Schema } from "effect"
import * as Composer from "../composer"
import * as ChatSession from "../core/chatSession"
import * as TranscriptModel from "../transcript/model"

// The chat previewer's Model (ChatPreview / ChatPreviewSession): a second
// chat session, live, with the transcript and the composer the page's own
// chat is drawn with.

export const PreviewModel = Schema.Struct({
  /** The chat the session is on: a chat stepped to inside the previewer is a new session. */
  chatId: Schema.String,
  session: ChatSession.Model,
  transcript: TranscriptModel.Model,
  composer: Composer.Model,
  /** The composer dock's height, for the transcript's room at its foot (useTranscriptPaddingBottom). */
  dockHeight: Schema.Number,
  /** Whether the transcript's arrival fades (`ViewerMotion`), as it was when this chat was opened. */
  fadesIn: Schema.Boolean,
  /** The session's command error (setCommandError), for the transcript. */
  commandError: Schema.NullOr(Schema.String),
})
export type PreviewModel = typeof PreviewModel.Type
