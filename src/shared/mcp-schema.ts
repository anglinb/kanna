import { Schema } from "effect"
import { MCP_PROVIDERS } from "./mcp"

export const McpProviderSchema = Schema.Literals(MCP_PROVIDERS)

export const McpServerInputSchema = Schema.Struct({
  id: Schema.optionalKey(Schema.String),
  name: Schema.String,
  transport: Schema.Literals(["stdio", "http", "sse"]),
  command: Schema.optionalKey(Schema.String),
  args: Schema.optionalKey(Schema.Array(Schema.String)),
  env: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
  url: Schema.optionalKey(Schema.String),
  headers: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
  providers: Schema.Array(McpProviderSchema),
  projectPath: Schema.optionalKey(Schema.String),
  /** For OAuth servers without dynamic client registration. */
  clientId: Schema.optionalKey(Schema.String),
  clientSecret: Schema.optionalKey(Schema.String),
})
