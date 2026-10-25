// The chat composer (components/chat-ui/ChatInput.tsx) on its own, docked at
// the foot of a page as the chat page docks it, in the state `?state=` names
// (support/composer-states.ts; gallery/composer.ts on the Foldkit side).
import { useMemo, useState } from "react"
import { ChatInput } from "../../../client/components/chat-ui/ChatInput"
import { DelegateControl, type ComposerDelegate } from "../../../client/components/chat-ui/DelegateControl"
import { TooltipProvider } from "../../../client/components/ui/tooltip"
import { projectDelegators, resolveDelegateTarget } from "../../../client/lib/delegators"
import { getProjectSidebarLabel } from "../../../client/lib/project-label"
import { flattenSidebarThreads } from "../../../client/lib/thread-sections"
import { useChatInputStore } from "../../../client/stores/chatInputStore"
import { useDelegateStore } from "../../../client/stores/delegateStore"
import { useProviderAuthStore } from "../../../client/stores/providerAuthStore"
import { useSidebarStore } from "../../../client/stores/sidebarStore"
import { PROVIDERS, type AgentProvider } from "../../../shared/types"
import {
  composerGalleryState,
  GALLERY_CHAT_ID,
  GALLERY_CONTEXT_WINDOW,
  GALLERY_PROJECT_ID,
  GALLERY_SIDEBAR,
  GALLERY_SKILLS,
} from "./support/composer-states"

const state = composerGalleryState(window.location.search)

/**
 * The stores ChatInput reads, as the state has them, before its first
 * render. Not at module level: main.tsx loads every gallery module, on the
 * app's own pages too.
 */
let seeded = false
function seedStores() {
  if (seeded) return
  seeded = true
  useSidebarStore.getState().setSnapshot(state.sidebar ?? GALLERY_SIDEBAR)
  if (state.auth) useProviderAuthStore.getState().setSnapshot(state.auth)
  if (state.draft) useChatInputStore.getState().setDraft(GALLERY_CHAT_ID, state.draft)
  if (state.attachments) useChatInputStore.getState().setAttachmentDrafts(GALLERY_CHAT_ID, state.attachments)
}

const listSkills = async (provider: AgentProvider) => ({ provider, skills: GALLERY_SKILLS, origin: "live" as const })
const submit = async () => {}
const nothing = () => {}

function useGalleryDelegate(): ComposerDelegate | undefined {
  const group = useSidebarStore((store) => store.data.projectGroups.find((item) => item.groupKey === GALLERY_PROJECT_ID) ?? null)
  const preference = useDelegateStore((store) => store.projects[GALLERY_PROJECT_ID])
  return useMemo(() => {
    if (!state.delegate || !group) return undefined
    const delegators = projectDelegators(flattenSidebarThreads({ projectGroups: [group] }), group.groupKey)
    const target = resolveDelegateTarget(delegators, preference)
    return {
      control: (
        <DelegateControl
          delegators={delegators}
          target={target}
          projectName={getProjectSidebarLabel(group).name}
          onPick={(chatId) => {
            const store = useDelegateStore.getState()
            store.setPreference(GALLERY_PROJECT_ID, chatId ? { on: true, chatId } : { on: false, chatId: store.projects[GALLERY_PROJECT_ID]?.chatId })
          }}
          onCreate={nothing}
        />
      ),
      target: target ? { chatId: target.chatId, title: target.title, provider: target.row.provider ?? null } : null,
    }
  }, [group, preference])
}

export default function ComposerGallery() {
  seedStores()
  const delegate = useGalleryDelegate()
  const [chatId] = useState(state.delegate ? null : GALLERY_CHAT_ID)
  return (
    <TooltipProvider>
      <div className="flex min-h-dvh flex-col justify-end bg-surface pb-4 text-foreground">
        <div className="relative pointer-events-auto">
          <ChatInput
            onSubmit={submit}
            onCancel={nothing}
            disabled={Boolean(state.disabled)}
            canCancel={Boolean(state.canCancel)}
            chatId={chatId}
            projectId={state.noProject ? null : GALLERY_PROJECT_ID}
            projectPath={state.noProject ? null : "/Users/maya/code/tidepool"}
            projectRepoLabel={state.noProject ? null : "tidepool/main"}
            activeProvider={null}
            availableProviders={PROVIDERS}
            contextWindowSnapshot={state.contextWindow ? GALLERY_CONTEXT_WINDOW : null}
            previousPrompt={state.previousPrompt ?? null}
            onEditModels={nothing}
            onListSkills={listSkills}
            delegate={delegate}
          />
        </div>
      </div>
    </TooltipProvider>
  )
}
