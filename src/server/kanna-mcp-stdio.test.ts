import { describe, expect, test } from "bun:test"
import { AGENT_CHAT_HEADER } from "./api/routes"
import {
  callTool,
  handleMessage,
  parseBridgeConfig,
  runMcpStdioServer,
  serializeBridgeConfig,
  type McpBridgeConfig,
} from "./kanna-mcp-stdio"
import { KANNA_TOOLS } from "./kanna-tools"

const config: McpBridgeConfig = {
  baseUrl: "http://127.0.0.1:1234",
  apiKey: "secret-key",
  chatId: "caller-chat",
}

interface Captured {
  url: string
  method: string
  headers: Record<string, string>
  body: unknown
}

function stubFetch(response: { status?: number; body: unknown }, captured: Captured[] = []) {
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const headers: Record<string, string> = {}
    for (const [key, value] of Object.entries((init?.headers ?? {}) as Record<string, string>)) {
      headers[key.toLowerCase()] = value
    }
    captured.push({
      url: String(input),
      method: init?.method ?? "GET",
      headers,
      body: init?.body ? JSON.parse(init.body as string) : undefined,
    })
    return new Response(JSON.stringify(response.body), { status: response.status ?? 200 })
  }) as unknown as typeof fetch
  return { impl, captured }
}

describe("bridge credentials", () => {
  test("round-trip", () => {
    expect(parseBridgeConfig(serializeBridgeConfig(config))).toEqual(config)
  })

  test("a file missing any field is rejected rather than half-used", () => {
    expect(() => parseBridgeConfig(JSON.stringify({ baseUrl: "x", apiKey: "y" }))).toThrow(/Malformed/)
  })
})

describe("callTool", () => {
  test("every call carries the key and the calling chat", async () => {
    const { impl, captured } = stubFetch({ body: { projects: [] } })
    await callTool(config, "list_projects", {}, impl)

    expect(captured[0]?.url).toBe("http://127.0.0.1:1234/api/v1/projects")
    expect(captured[0]?.headers.authorization).toBe("Bearer secret-key")
    expect(captured[0]?.headers[AGENT_CHAT_HEADER]).toBe("caller-chat")
  })

  test("list_chats maps its filters onto the query string", async () => {
    const { impl, captured } = stubFetch({ body: { chats: [], total: 0 } })
    await callTool(config, "list_chats", { projectId: "p1", includeArchived: true, limit: 5 }, impl)

    const url = new URL(captured[0]!.url)
    expect(url.pathname).toBe("/api/v1/chats")
    expect(url.searchParams.get("projectId")).toBe("p1")
    expect(url.searchParams.get("includeArchived")).toBe("true")
    expect(url.searchParams.get("limit")).toBe("5")
  })

  test("send_message posts only the fields the API knows", async () => {
    const { impl, captured } = stubFetch({ status: 202, body: { chatId: "c1" } })
    await callTool(
      config,
      "send_message",
      { chatId: "c1", content: "hello", model: "opus", nonsense: "drop me" },
      impl
    )

    expect(captured[0]?.method).toBe("POST")
    expect(captured[0]?.url).toBe("http://127.0.0.1:1234/api/v1/chats/c1/messages")
    expect(captured[0]?.body).toEqual({ content: "hello", model: "opus" })
  })

  test("reload posts to the reload route", async () => {
    const { impl, captured } = stubFetch({ body: { projects: 1, chats: 2 } })
    await callTool(config, "reload", {}, impl)

    expect(captured[0]?.method).toBe("POST")
    expect(captured[0]?.url).toBe("http://127.0.0.1:1234/api/v1/reload")
  })

  test("a chat id is escaped into the path", async () => {
    const { impl, captured } = stubFetch({ body: {} })
    await callTool(config, "cancel_chat", { chatId: "a/b" }, impl)
    expect(captured[0]?.url).toBe("http://127.0.0.1:1234/api/v1/chats/a%2Fb/cancel")
  })

  test("an unknown tool is refused before any request goes out", async () => {
    const { impl, captured } = stubFetch({ body: {} })
    await expect(callTool(config, "delete_everything", {}, impl)).rejects.toThrow(/Unknown tool/)
    expect(captured).toHaveLength(0)
  })
})

describe("MCP protocol", () => {
  test("initialize advertises tools and the instructions", async () => {
    const response = await handleMessage(config, { jsonrpc: "2.0", id: 1, method: "initialize" })
    expect(response?.id).toBe(1)
    const result = response?.result as Record<string, unknown>
    expect(result.capabilities).toEqual({ tools: {} })
    expect(String(result.instructions)).toContain("Kanna instance you are running inside")
  })

  test("notifications get no reply", async () => {
    expect(await handleMessage(config, { jsonrpc: "2.0", method: "notifications/initialized" })).toBeNull()
  })

  test("tools/list advertises every tool with a JSON Schema", async () => {
    const response = await handleMessage(config, { jsonrpc: "2.0", id: 2, method: "tools/list" })
    const tools = (response?.result as { tools: { name: string; inputSchema: Record<string, unknown> }[] }).tools

    expect(tools.map((tool) => tool.name).sort()).toEqual(KANNA_TOOLS.map((tool) => tool.name).sort())
    const sendMessage = tools.find((tool) => tool.name === "send_message")!
    expect(sendMessage.inputSchema.type).toBe("object")
    expect(sendMessage.inputSchema.required).toEqual(["chatId", "content"])
  })

  test("no delete tool is exposed", async () => {
    const response = await handleMessage(config, { jsonrpc: "2.0", id: 2, method: "tools/list" })
    const names = (response?.result as { tools: { name: string }[] }).tools.map((tool) => tool.name)
    expect(names.some((name) => name.includes("delete") || name.includes("remove"))).toBe(false)
  })

  test("a refused call comes back as a tool error, not a protocol error", async () => {
    const { impl } = stubFetch({ status: 409, body: { error: "This chat was itself started by an agent" } })
    const response = await handleMessage(
      config,
      { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "create_chat", arguments: { projectId: "p" } } },
      impl
    )

    expect(response?.error).toBeUndefined()
    const result = response?.result as { isError: boolean; content: { text: string }[] }
    expect(result.isError).toBe(true)
    expect(result.content[0]?.text).toContain("409")
    expect(result.content[0]?.text).toContain("started by an agent")
  })

  test("a successful call returns the API body as text", async () => {
    const { impl } = stubFetch({ body: { projects: [{ id: "p1" }] } })
    const response = await handleMessage(
      config,
      { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "list_projects", arguments: {} } },
      impl
    )
    const result = response?.result as { isError: boolean; content: { text: string }[] }
    expect(result.isError).toBe(false)
    expect(JSON.parse(result.content[0]!.text)).toEqual({ projects: [{ id: "p1" }] })
  })

  test("an unknown request method gets method-not-found; an unknown notification is ignored", async () => {
    const request = await handleMessage(config, { jsonrpc: "2.0", id: 9, method: "resources/list" })
    expect((request?.error as { code: number }).code).toBe(-32601)
    expect(await handleMessage(config, { jsonrpc: "2.0", method: "notifications/cancelled" })).toBeNull()
  })
})

describe("stdio loop", () => {
  function streamOf(lines: string[]) {
    return new ReadableStream<Uint8Array>({
      start(controller) {
        for (const line of lines) controller.enqueue(new TextEncoder().encode(line))
        controller.close()
      },
    })
  }

  test("reads newline-delimited requests and answers each one", async () => {
    const written: string[] = []
    await runMcpStdioServer(config, {
      input: streamOf([
        `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" })}\n`,
        `${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`,
        `${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "ping" })}\n`,
      ]),
      write: (line) => written.push(line),
      warn: () => {},
    })

    expect(written.map((line) => JSON.parse(line).id)).toEqual([1, 2])
  })

  test("a request split across chunks is still handled once", async () => {
    const written: string[] = []
    const message = JSON.stringify({ jsonrpc: "2.0", id: 7, method: "ping" })
    await runMcpStdioServer(config, {
      input: streamOf([message.slice(0, 10), `${message.slice(10)}\n`]),
      write: (line) => written.push(line),
      warn: () => {},
    })

    expect(written).toHaveLength(1)
    expect(JSON.parse(written[0]!).id).toBe(7)
  })

  test("a malformed line gets a parse error and does not stop the loop", async () => {
    const written: string[] = []
    await runMcpStdioServer(config, {
      input: streamOf(["not json\n", `${JSON.stringify({ jsonrpc: "2.0", id: 5, method: "ping" })}\n`]),
      write: (line) => written.push(line),
      warn: () => {},
    })

    expect(JSON.parse(written[0]!).error.code).toBe(-32700)
    expect(JSON.parse(written[1]!).id).toBe(5)
  })
})
