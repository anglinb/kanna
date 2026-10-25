// src/client/components/ui/textarea.tsx (gallery/ui-textarea.ts on the Foldkit side).
import { useState } from "react"
import { Textarea } from "../../../client/components/ui/textarea"

export default function TextareaGallery() {
  const [message, setMessage] = useState("")
  return (
    <div className="flex w-96 flex-col gap-3 bg-background p-4 text-foreground">
      <Textarea aria-label="Commit message" placeholder="Describe the change" rows={3} value={message} onChange={(event) => setMessage(event.target.value)} />
      <p>{message.length} characters</p>
      <Textarea aria-label="Disabled notes" value="Nothing to edit" disabled readOnly className="min-h-24" />
    </div>
  )
}
