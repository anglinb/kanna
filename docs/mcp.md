# MCP servers in Kanna

Settings → MCP Servers owns server definitions and authentication. Add an HTTP,
SSE, or local stdio server; test its connection; complete OAuth in the browser;
then enable it for Claude, Codex, Cursor, and/or Pi. Enabling another provider
uses the same Kanna-owned login. Grok's adapter does not yet accept injected
servers.

## Storage and ownership

The active server data directory contains:

- `mcp.json`: versioned definitions, provider assignments, optional project
  folders, and configured arguments/environment/headers.
- `mcp-credentials.json`: Kanna's OAuth client registration, access/refresh
  tokens, expiration, and discovery metadata.

Both files are replaced atomically with mode `0600`. OAuth tokens, client
secrets, arguments, and environment/header values are omitted from settings
snapshots. An edit retains omitted arguments/credentials unless the connection
target changes. Sign out clears the
OAuth credentials; removing a server also removes its credentials. Refreshes
are serialized per server, and an old callback cannot restore credentials
after sign-out, deletion, or a change of upstream identity.

The first version loads these files at startup. Edit through settings; manual
file edits require a Kanna restart. The files belong to the machine running
Kanna. Sharing a login across providers does not upload it to Kanna Cloud or
copy provider token caches.

## Runtime

Kanna is the upstream MCP client. Each chat has a separate upstream protocol
session, while OAuth credentials are shared per definition. Harnesses receive
only a loopback bridge URL and a generated bridge token. Bridge server names
use a `kanna-` prefix, so provider-native stdio/HTTP definitions cannot merge
with them:

- Claude: HTTP MCP definitions in the Agent SDK session.
- Codex: thread-scoped `mcp_servers.<name>` configuration, including resume/fork.
- Cursor: a temporary plugin containing `mcp.json`.
- Pi: native tool definitions calling the same upstream clients.

The bridges preserve tools, resources, prompts, server instructions, progress,
and cancellation. Pi exposes tools only. Sampling, elicitation, resource
subscriptions, completion, and experimental task capabilities are not
advertised. The HTTP listener and local command transports use the injected
`HttpHost` and `ProcessSpawner` services; no provider configuration file is
rewritten at runtime.

Provider assignments/configuration changes take effect at the next message.
Claude, Codex, and Pi recreate their session with the existing conversation
token when the injected server set changes. Cursor starts a new process each
turn. Closing a chat releases its MCP clients and local server processes.

## Import and authentication

Import definitions from Claude's global `.claude.json`, Codex's `config.toml`
(`CODEX_HOME` is respected), Cursor's global `.cursor/mcp.json`, or pasted
`mcpServers` JSON / `mcp_servers` TOML. The API also accepts a project folder
for project imports/scoping. Existing Kanna names are never silently replaced,
and batch imports validate before a single config write.

Original provider files stay unchanged. Their unrelated servers still load
normally; an imported definition is an independent Kanna-owned copy, with no
ongoing synchronization. Remove the original configuration separately if a
harness exposes both its native entry and the Kanna bridge. Unsupported native
options (including credential helpers and tool filters) are rejected explicitly.

Existing provider OAuth sessions are not imported: Kanna registers as its own
OAuth client. Sign in once in Kanna, then reuse that login across providers.
For servers without dynamic registration, advanced settings accept `clientId`
and `clientSecret`. The OAuth callback uses a loopback URL on the Kanna machine;
remote-browser callbacks and fixed callback-port configuration are not included.

Advanced settings accept `args`, `env`, `headers`, `clientId`, and
`clientSecret`. Command arguments and environment/header values support
`${NAME}`, `${env:NAME}`, and `${NAME:-default}` using Kanna's environment.
Server URLs must be explicit. A missing variable fails before connection.

`managed-mcp.test.ts` exercises real HTTP/stdio MCP clients and an OAuth server:
PKCE/state and callback replay protection, cross-provider use, concurrent
rotating refresh tokens, restart persistence, secret redaction, scope,
revocation, cancellation, atomic imports, and local-process cleanup.
