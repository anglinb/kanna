// src/client/components/ui/input.tsx (gallery/ui-input.ts on the Foldkit side).
import { useState } from "react"
import { Input } from "../../../client/components/ui/input"

export default function InputGallery() {
  const [name, setName] = useState("kanna")
  return (
    <div className="flex w-96 flex-col gap-3 bg-background p-4 text-foreground">
      <Input type="text" aria-label="Name" value={name} onChange={(event) => setName(event.target.value)} />
      <p>Hello, {name}</p>
      <Input type="text" aria-label="Search" placeholder="Search projects" />
      <Input type="text" aria-label="Disabled" value="read only" disabled readOnly />
      <Input type="password" aria-label="Token" className="font-mono" value="secret" readOnly />
    </div>
  )
}
