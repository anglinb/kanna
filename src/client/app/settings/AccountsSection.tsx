import { useState } from "react"
import { Plus, RefreshCw } from "lucide-react"
import type { AccountInput, ProviderAccount } from "../../../shared/accounts"
import { PROVIDERS } from "../../../shared/types"
import type { KannaSocket } from "../socket"
import { useProviderAuthStore } from "../../stores/providerAuthStore"
import { AuthCard } from "../../components/auth/AuthCard"
import { Button } from "../../components/ui/button"
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "../../components/ui/dialog"
import { Input } from "../../components/ui/input"
import { SelectItem } from "../../components/ui/select"
import { SettingsActionButton, SettingsErrorBanner, SettingsGroup, SettingsRow, SettingsSelect } from "./shared"

export function AccountsSection({ socket }: { socket: KannaSocket }) {
  const snapshot = useProviderAuthStore((store) => store.snapshot)
  const [draft, setDraft] = useState<AccountInput | null>(null)
  const [connecting, setConnecting] = useState<string | null>(null)
  const [keyAccount, setKeyAccount] = useState<ProviderAccount | null>(null)
  const [replacementKey, setReplacementKey] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const perform = async (action: () => Promise<unknown>) => {
    setBusy(true)
    setError(null)
    try { await action() } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
    finally { setBusy(false) }
  }
  const account = snapshot?.accounts?.find((entry) => entry.id === connecting)
  const service = account ? snapshot?.services.find((entry) => entry.service === account.provider) : null
  const isKey = draft?.provider === "cursor" || draft?.provider === "pi"
  const label = (entry: ProviderAccount) => `${PROVIDERS.find((provider) => provider.id === entry.provider)?.label ?? entry.provider} · ${entry.label}`
  return <>
    {error ? <SettingsErrorBanner message={error} /> : null}
    <SettingsGroup title="Saved accounts" trailing={<div className="flex items-center gap-3">
      <SettingsActionButton disabled={busy} icon={<RefreshCw />} onClick={() => void perform(() => socket.command({ type: "auth.refresh", force: true }))}>Refresh</SettingsActionButton>
      <SettingsActionButton disabled={busy} icon={<Plus />} onClick={() => { setError(null); setDraft({ provider: "claude", label: "", apiProvider: "openai" }) }}>Add account</SettingsActionButton>
    </div>}>
      {snapshot?.accounts?.map((entry) => <SettingsRow key={entry.id} title={label(entry)} description={entry.identity ?? (entry.mode === "existing" ? "Uses the current CLI or API connection" : entry.statusDetail ?? entry.authStatus.replaceAll("_", " "))}>
        <div className="flex flex-wrap items-center gap-3">
          <SettingsActionButton disabled={busy || snapshot.defaultAccountIds?.[entry.provider] === entry.id} onClick={() => void perform(() => socket.command({ type: "accounts.setDefault", provider: entry.provider, accountId: entry.id }))}>
            {snapshot.defaultAccountIds?.[entry.provider] === entry.id ? "Default" : "Use by default"}
          </SettingsActionButton>
          {entry.mode === "native" ? <SettingsActionButton disabled={busy} onClick={() => { setConnecting(entry.id); void perform(() => socket.command({ type: "accounts.login", accountId: entry.id })) }}>{entry.authStatus === "signed_in" ? "Reconnect" : "Sign in"}</SettingsActionButton> : null}
          {entry.mode === "apiKey" ? <SettingsActionButton disabled={busy} onClick={() => { setReplacementKey(""); setKeyAccount(entry); setError(null) }}>Replace key</SettingsActionButton> : null}
          {entry.mode !== "existing" ? <SettingsActionButton disabled={busy} onClick={() => void perform(() => socket.command({ type: "accounts.remove", accountId: entry.id }))}>Remove</SettingsActionButton> : null}
        </div>
      </SettingsRow>)}
    </SettingsGroup>
    <Dialog open={Boolean(draft)} onOpenChange={(open) => { if (!open && !busy) setDraft(null) }}>
      <DialogContent size="md">
        <DialogHeader><DialogTitle>Add account</DialogTitle><DialogDescription>Choose an account for new chats. Existing chats keep their selected account.</DialogDescription></DialogHeader>
        <DialogBody>{draft ? <form onSubmit={(event) => {
          event.preventDefault()
          void perform(async () => {
            const result = await socket.command<{ accountId: string }>({ type: "accounts.create", account: draft })
            setDraft(null)
            if (!isKey) { setConnecting(result.accountId); await socket.command({ type: "accounts.login", accountId: result.accountId }) }
          })
        }}>
          <SettingsGroup>
            <SettingsRow title="Provider"><SettingsSelect aria-label="Account provider" value={draft.provider} onValueChange={(provider) => setDraft({ provider: provider as AccountInput["provider"], label: draft.label, apiProvider: "openai" })}>
              {PROVIDERS.filter((provider) => provider.id !== "grok").map((provider) => <SelectItem key={provider.id} value={provider.id}>{provider.label}</SelectItem>)}
            </SettingsSelect></SettingsRow>
            <SettingsRow title="Name" wideControl><Input aria-label="Account name" required maxLength={80} value={draft.label} onChange={(event) => setDraft({ ...draft, label: event.target.value })} placeholder="Work" /></SettingsRow>
            {draft.provider === "pi" ? <SettingsRow title="API provider"><SettingsSelect aria-label="Account API provider" value={draft.apiProvider ?? "openai"} onValueChange={(apiProvider) => setDraft({ ...draft, apiProvider: apiProvider as AccountInput["apiProvider"], baseUrl: "" })}>
              <SelectItem value="openai">OpenAI</SelectItem><SelectItem value="openrouter">OpenRouter</SelectItem><SelectItem value="custom">Custom</SelectItem>
            </SettingsSelect></SettingsRow> : null}
            {isKey ? <SettingsRow title="API key" wideControl><Input aria-label="Account API key" type="password" autoComplete="new-password" required value={draft.apiKey ?? ""} onChange={(event) => setDraft({ ...draft, apiKey: event.target.value })} /></SettingsRow> : null}
            {draft.provider === "pi" ? <SettingsRow title="API URL" wideControl><Input aria-label="Account API URL" type="url" required={draft.apiProvider === "custom"} value={draft.baseUrl ?? ""} onChange={(event) => setDraft({ ...draft, baseUrl: event.target.value })} placeholder={draft.apiProvider === "openrouter" ? "https://openrouter.ai/api/v1" : "https://api.openai.com/v1"} /></SettingsRow> : null}
          </SettingsGroup>
          {error ? <SettingsErrorBanner message={error} /> : null}
          <div className="flex justify-end gap-2 pt-4"><Button type="button" variant="outline" disabled={busy} onClick={() => setDraft(null)}>Cancel</Button><Button type="submit" disabled={busy}>Add account</Button></div>
        </form> : null}</DialogBody>
      </DialogContent>
    </Dialog>
    <Dialog open={Boolean(keyAccount)} onOpenChange={(open) => { if (!open && !busy) { setKeyAccount(null); setReplacementKey("") } }}>
      <DialogContent size="md">
        <DialogHeader><DialogTitle>Replace API key</DialogTitle><DialogDescription>{keyAccount ? label(keyAccount) : "Account"} keeps its saved chats.</DialogDescription></DialogHeader>
        <DialogBody><form onSubmit={(event) => { event.preventDefault(); if (keyAccount) void perform(async () => {
          await socket.command({ type: "accounts.updateKey", accountId: keyAccount.id, apiKey: replacementKey })
          setKeyAccount(null); setReplacementKey("")
        }) }}>
          <SettingsGroup><SettingsRow title="New API key" wideControl><Input aria-label="Replacement API key" type="password" autoComplete="new-password" required value={replacementKey} onChange={(event) => setReplacementKey(event.target.value)} /></SettingsRow></SettingsGroup>
          {error ? <SettingsErrorBanner message={error} /> : null}
          <div className="flex justify-end gap-2 pt-4"><Button type="button" variant="outline" disabled={busy} onClick={() => { setKeyAccount(null); setReplacementKey("") }}>Cancel</Button><Button type="submit" disabled={busy}>Save key</Button></div>
        </form></DialogBody>
      </DialogContent>
    </Dialog>
    <Dialog open={Boolean(account && service)} onOpenChange={(open) => { if (!open) setConnecting(null) }}>
      <DialogContent size="md">
        <DialogHeader><DialogTitle>{account ? label(account) : "Account"}</DialogTitle><DialogDescription>Sign in to this account’s separate profile.</DialogDescription></DialogHeader>
        <DialogBody>{error ? <SettingsErrorBanner message={error} /> : null}{account && service ? <AuthCard socket={socket} service={{ ...service, accountId: account.id, label: label(account), account: account.identity, authStatus: account.authStatus, login: account.login, statusDetail: account.statusDetail }} /> : null}
          {account && service?.installed && account.login.phase === "idle" ? <Button className="mt-4" disabled={busy} onClick={() => void perform(() => socket.command({ type: "accounts.login", accountId: account.id }))}>{account.authStatus === "signed_in" ? "Sign in again" : "Sign in"}</Button> : null}
        </DialogBody>
      </DialogContent>
    </Dialog>
  </>
}
