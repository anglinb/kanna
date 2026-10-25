// src/client/components/ui/select.tsx as the app uses it: a placeholder,
// grouped end-aligned items (settings), icons in items, a disabled item and a
// disabled select (gallery/ui-select.ts on the Foldkit side).
import { useState } from "react"
import { Globe, Lock } from "lucide-react"
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "../../../client/components/ui/select"
import { SELECT_MODES } from "../../gallery-support/select-options"

export default function SelectGallery() {
  const [visibility, setVisibility] = useState<string | undefined>(undefined)
  const [mode, setMode] = useState("queue")
  const [connection, setConnection] = useState("stdio")
  return (
    <div className="flex min-h-dvh items-start gap-8 bg-background p-8 text-foreground">
      <div className="w-56">
        <Select value={visibility} onValueChange={setVisibility}>
          <SelectTrigger className="pl-[11px] [&>span]:flex [&>span]:items-center [&>span]:gap-2">
            <SelectValue placeholder="Select visibility" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="private">
              <span className="flex items-center gap-2">
                <Lock className="size-4 text-muted-foreground" />
                <span className="pl-[1px]">Private</span>
              </span>
            </SelectItem>
            <SelectItem value="public">
              <span className="flex items-center gap-2">
                <Globe className="size-4 text-muted-foreground" />
                <span className="pl-[1px]">Public</span>
              </span>
            </SelectItem>
          </SelectContent>
        </Select>
      </div>
      <div className="ml-auto">
        <Select value={mode} onValueChange={setMode}>
          <SelectTrigger aria-label="Follow-up mode" className="w-40">
            <SelectValue />
          </SelectTrigger>
          <SelectContent align="end">
            <SelectGroup>
              {SELECT_MODES.map((option) => (
                <SelectItem key={option.value} value={option.value} disabled={option.disabled}>{option.label}</SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
      </div>
      <div className="w-40">
        <Select value="stdio" disabled>
          <SelectTrigger aria-label="Transport">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="stdio">stdio</SelectItem>
          </SelectContent>
        </Select>
      </div>
      {/* Inside a form, as McpSection's: Radix adds a hidden native select. */}
      <form className="w-40" onSubmit={(event) => event.preventDefault()}>
        <Select value={connection} onValueChange={setConnection}>
          <SelectTrigger aria-label="Connection type">
            <SelectValue />
          </SelectTrigger>
          <SelectContent align="end">
            <SelectGroup>
              <SelectItem value="stdio">stdio</SelectItem>
              <SelectItem value="sse">sse</SelectItem>
              <SelectItem value="http" disabled>http</SelectItem>
            </SelectGroup>
          </SelectContent>
        </Select>
      </form>
    </div>
  )
}
