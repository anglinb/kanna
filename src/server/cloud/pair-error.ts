import { Schema } from "effect"

/** The terminal's confirmation prompt could not be read. */
export class PairPromptError extends Schema.TaggedError<PairPromptError>()(
  "@kanna/server/cloud/pair-command/PairPromptError",
  {
    message: Schema.String,
    cause: Schema.Defect(),
  },
) {}
