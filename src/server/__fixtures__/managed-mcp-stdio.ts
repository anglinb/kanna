import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js"

const server = new Server({ name: "local-fixture", version: "1" }, { capabilities: { tools: {} } })
server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: [{ name: "context", inputSchema: { type: "object" } }] }))
server.setRequestHandler(CallToolRequestSchema, () => ({
  content: [{ type: "text", text: JSON.stringify({ cwd: process.cwd(), key: process.env.FIXTURE_KEY, argument: process.argv.at(-1), pid: process.pid }) }],
}))
await server.connect(new StdioServerTransport())
