import { defineScenario, type Scenario } from "../scenario"
import { captureScrolled } from "./gallery-messages-text"

// src/foldkit/transcript/messages against the React rows on messages that
// name other chats, with a sidebar that knows some of them: quotes with a
// project or Archived caption, one for a chat nobody lists, report lines by
// live title, an adoption naming both chats, a chat card, and the link back
// to a parent (listed, and deleted).
export const scenarios: Scenario[] = [
  defineScenario({
    name: "gallery-messages-references",
    route: "/__gallery/messages-references",
    async run(context) {
      await captureScrolled(context)
    },
  }),
]
