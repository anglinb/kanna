// The Foldkit client: the root program, assembled. See docs/foldkit-migration.md.
//
//   model.ts          Model and Flags
//   message.ts        root Messages
//   update.ts         init and update
//   commands.ts       the root's Commands
//   subscriptions.ts  snapshot subscriptions and the socket ManagedResource
//   view.ts           auth gate and layout
//   route.ts          routes
//   run.ts            boots it

export { Flags, Model, readFlags } from "./model"
export { Message } from "./message"
export { init, update } from "./update"
export { managedResources, subscriptions } from "./subscriptions"
export { view } from "./view"
