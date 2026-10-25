// src/client/components/ui/app-dialog.tsx: confirm, prompt (with reset) and
// alert, opened from buttons and answered (gallery/ui-app-dialog.ts on the
// Foldkit side).
import { useState } from "react"
import { AppDialogProvider, useAppDialog } from "../../../client/components/ui/app-dialog"

const triggerClass = "rounded-md border border-border px-3 py-1.5 text-sm"

function Triggers() {
  const dialog = useAppDialog()
  const [answer, setAnswer] = useState("none")
  return (
    <div className="flex min-h-dvh flex-col items-start gap-3 bg-background p-6 text-foreground">
      <button
        type="button"
        className={triggerClass}
        onClick={async () => {
          const confirmed = await dialog.confirm({
            title: "Delete project?",
            description: "Its chats stay on disk.",
            confirmLabel: "Delete",
            confirmVariant: "destructive",
          })
          setAnswer(`confirm: ${confirmed}`)
        }}
      >
        Delete project
      </button>
      <button
        type="button"
        className={triggerClass}
        onClick={async () => {
          const value = await dialog.prompt({
            title: "Rename chat",
            placeholder: "Chat title",
            initialValue: "Port the UI",
            resetLabel: "Use generated title",
            resetValue: "Foldkit primitives",
            confirmLabel: "Rename",
          })
          setAnswer(`prompt: ${value === null ? "cancelled" : value}`)
        }}
      >
        Rename
      </button>
      <button
        type="button"
        className={triggerClass}
        onClick={async () => {
          await dialog.alert({ title: "Kanna is up to date", description: "Version 0.68.0" })
          setAnswer("alert: closed")
        }}
      >
        About
      </button>
      <p className="text-sm">Answer: {answer}</p>
    </div>
  )
}

export default function AppDialogGallery() {
  return (
    <AppDialogProvider>
      <Triggers />
    </AppDialogProvider>
  )
}
