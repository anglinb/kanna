import { describe, expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import type { HydratedSkillToolCall, HydratedSubagentTaskToolCall } from "../../../shared/types"
import { ToolCallMessage } from "./ToolCallMessage"
import { ReadResultImages, subagentResultText } from "./ToolCallExpandedContent"

describe("ToolCallMessage", () => {
  test("renders read result image blocks as inline images", () => {
    const html = renderToStaticMarkup(
      <ReadResultImages
        images={[
          {
            type: "image",
            data: "ZmFrZS1pbWFnZS1kYXRh",
            mimeType: "image/png",
          },
        ]}
      />
    )

    expect(html).toContain("data:image/png;base64,ZmFrZS1pbWFnZS1kYXRh")
    expect(html).toContain("alt=\"Read result 1\"")
  })

  test("renders the user-facing skill label", () => {
    const message: HydratedSkillToolCall = {
      id: "skill-1",
      kind: "tool",
      toolKind: "skill",
      toolName: "Skill",
      toolId: "tool-1",
      input: { skill: "shadcn" },
      timestamp: new Date().toISOString(),
    }

    const html = renderToStaticMarkup(<ToolCallMessage message={message} />)

    expect(html).toContain("Read Skill – shadcn")
  })

  test("titles an Agent row with its type and description", () => {
    const message: HydratedSubagentTaskToolCall = {
      id: "agent-1",
      kind: "tool",
      toolKind: "subagent_task",
      toolName: "Agent",
      toolId: "tool-1",
      input: { subagentType: "Explore", description: "Locate the loop" },
      timestamp: new Date().toISOString(),
    }

    expect(renderToStaticMarkup(<ToolCallMessage message={message} />)).toContain("Explore: Locate the loop")
    expect(renderToStaticMarkup(<ToolCallMessage message={{ ...message, input: { subagentType: "Explore" } }} />)).toContain("Explore")
  })
})

describe("subagentResultText", () => {
  test("joins the text blocks of an SDK result", () => {
    expect(subagentResultText([
      { type: "text", text: "## Findings" },
      { type: "image", data: "..." },
      { type: "text", text: "Done." },
    ])).toBe("## Findings\n\nDone.")
  })

  test("passes a plain string through and stringifies anything else", () => {
    expect(subagentResultText("Findings.")).toBe("Findings.")
    expect(subagentResultText({ content: [{ type: "text", text: "nested" }] })).toBe("nested")
    expect(subagentResultText({ status: "ok" })).toBe("{\n  \"status\": \"ok\"\n}")
    expect(subagentResultText(undefined)).toBe("")
  })
})
