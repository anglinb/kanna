// The setup wizard's This Mac step (components/auth/MacSetupStep.tsx
// MacSetupCards) in each state the app can report (gallery/setup-mac.ts on
// the Foldkit side).
import { MacSetupCards } from "../../../client/components/auth/MacSetupStep"
import { MAC_STATES } from "./support/setup-states"

export default function SetupMacGallery() {
  return (
    <div className="min-h-dvh bg-background p-6 text-foreground">
      <div className="grid grid-cols-[400px_400px] items-start justify-center gap-6">
        {MAC_STATES.map((state, index) => (
          <div key={index}>
            <MacSetupCards state={state} />
          </div>
        ))}
      </div>
    </div>
  )
}
