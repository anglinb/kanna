# Provider accounts

Kanna can keep multiple provider accounts connected at once. Settings → Providers
contains Saved accounts, with a default account for each harness. The composer
selects an account before the first message; subsequent messages keep that account.
Changing a default affects new conversations, not existing ones.

## Supported accounts

| Harness | Additional accounts |
| --- | --- |
| Claude | Native Claude Code login in a separate `CLAUDE_CONFIG_DIR` |
| Codex | Native Codex login in a separate `CODEX_HOME`, with file credential storage explicitly selected |
| Cursor | Separate Cursor API keys, supplied through the process environment |
| Pi | Separate OpenAI, OpenRouter, or custom OpenAI-compatible API connections |
| Grok | Existing CLI account only |

Every harness also has an Existing CLI account (for Pi, the existing API
connection). These entries refer to the user's current configuration. Kanna
does not extract or overwrite existing CLI credentials. Adding a managed native
account requires signing in once in its new profile. API keys entered for Cursor
or Pi are configured credentials, not a verified account identity or balance.

Native profiles have their own settings and session storage. Existing global
Claude/Codex settings, plugin installations, and native MCP definitions are not
copied into a new profile. Kanna-managed MCP bridges are still injected into
each turn. Project settings continue to be read by the native harness.

Claude's documented multi-account isolation covers claude.ai logins and API keys;
two Console browser sign-ins without API keys are not isolated by configuration
directories. Those Console accounts are outside the supported managed-login path. New Claude
profiles set `forceLoginMethod: "claudeai"` to select subscription login.

## Ownership and persistence

`<dataDir>/accounts.json` holds account IDs, labels, defaults, and Cursor/Pi API
keys. Writes are serialized, atomic replacements with file mode `0600`. This is
private local storage, not an encrypted portable vault. WebSocket snapshots
contain account metadata, status, and login prompts; they never contain API keys
or process environments.

Native state lives under `<dataDir>/accounts/<accountId>/<provider>/`. Each
provider directory starts with mode `0700`. Claude owns its OAuth flow and token
refresh, including its directory-specific macOS Keychain entry. Codex owns its
OAuth flow and refresh in the account's `auth.json`; login, status, and app-server
commands explicitly select file storage. Kanna does not maintain a second copy
of native refresh tokens or refresh them itself.

Environment overrides are passed to individual processes. They never change the
server's environment. Managed Claude profiles clear inherited Claude OAuth/API
credentials and cloud-provider selectors; managed Codex profiles clear inherited
OpenAI/Codex keys and endpoint overrides. Existing CLI accounts retain the
previous inherited-environment behavior.

Chats persist an `accountIds` map keyed by harness through `chat_account_set`
events. Binding happens before a message starts or queues, and is serialized.
Forks inherit their source account; new delegated chats inherit their creator's
account when using that harness. Legacy conversations without a binding retain
the existing CLI account. Missing or mismatched accounts fail rather than falling
back to another login. A chat's account cannot be changed after binding.

Cursor/Pi keys can be replaced without changing the account ID or losing chats.
Replacement closes idle bound sessions and is rejected while a chat is busy.

Removing an account is rejected while saved chats reference it. Native removal
first logs out through that profile's CLI, then removes its metadata and profile
directory. Reconnecting closes idle bound harness sessions and is rejected while
one of the account's chats is busy.

## Portability boundaries

This change supplies account profiles and concurrent account selection. It does
not synchronize credentials between machines or turn native OAuth tokens into a
provider-independent login. Claude Keychain credentials do not travel with a
directory copy. An encrypted export/import and credential-store abstraction can
build on these stable account IDs, with reconnect required where a provider's
credential backend cannot be transferred.

The existing usage-limit service and model catalogs remain machine-wide. Saved
accounts report their own authentication state and identity, not separate usage
balances. No automatic account rotation or quota fallback is performed.

## Validation

Account tests exercise private persistence, restart, concurrent saves, invalid
definitions, snapshot redaction, independent native login/code flows, default
changes, legacy conversations, queued messages, forks, delegation, and replay.
Provider adapter tests cover their existing turn and resume behavior. Native
account tests use fake login processes; they do not sign in to real accounts.
