// The chat composer (components/chat-ui/ChatInput.tsx, ChatPreferenceControls,
// HoldToStop, RecordingWaveform, DelegateControl; hooks/useComposer,
// useVoiceRecorder). Embedded by chat/, with the page's inputs as view inputs
// (`{ app, page, requests }`).
//
//   model.ts              the composer's own state
//   message.ts            its Messages
//   context.ts            its props (ChatInput's, from the page or the root
//                         Model) and what it works out from them
//   update.ts             ChatInput's handlers and effects
//   view.ts               ChatInput's JSX
//   preferenceControls.ts ChatPreferenceControls (the options row's pickers)
//   delegateControl.ts    DelegateControl
//   controls.ts           lib/composer.ts (the composer's rules)
//   commands.ts           side effects: uploads, skills, focus, the recorder
//   effects.ts            Mounts: the event bridge, the textarea, the waveform
//   subscriptions.ts      page requests, the hold's clock, standalone mode
//   recorder.ts           useVoiceRecorder's live handles
//   paste.ts              the paste helpers

export { Model, init } from "./model"
export { Message } from "./message"
export { update, updateWith, reconcile } from "./update"
export { view, contextFromInputs, pageComposerInputs, type ViewInputs } from "./view"
export { subscriptions } from "./subscriptions"
export { contextFromApp, propsFromApp, type ComposerDelegate, type ComposerProps, type Context, type PageComposerInputs } from "./context"
