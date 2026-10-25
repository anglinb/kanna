// The setup wizard (components/auth/SetupWizard and its cards), open over
// any page, and App.tsx's rule for opening it on launch. The slice contract
// is in app/slice.ts.
//
//   model.ts          Model, Message, init
//   update.ts         update, and observe: the launch rule and the wizard's effects
//   view.ts           the wizard
//   rows.ts           SetupList/SetupRow/Done and the This Mac step (MacSetupStep.tsx)
//   subscriptions.ts  window.__kannaOpenSetup, the Mac app's state, the cloud poll
//
// The sign-in cards it draws are settings/auth-cards.ts (AuthCard), shared
// with Settings, the home page and the composer.

export { Model, Message, init } from "./model"
export { update, observe } from "./update"
export { view } from "./view"
export { subscriptions } from "./subscriptions"
