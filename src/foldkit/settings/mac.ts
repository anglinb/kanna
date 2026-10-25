import { Duration, Effect, Schema, Stream } from "effect"
import { Command, Dom, Submodel, Subscription } from "foldkit"
import { defineMessageUnion } from "foldkit/message"
import { macSetup, type MacQuitBehavior, type MacSetupState } from "./macApp"
import { opaque } from "../core/schema"
import { Check } from "../ui/icons"
import * as Select from "../ui/select"
import { switchControl } from "../ui/switch"
import { makeSectionMount } from "./activeSection"
import { SETTINGS_ROWS } from "./registry"
import { liftChild, sectionLabel, sectionSubtitle, type AppModel, type SectionReturn, type SectionViewInputs } from "./section"
import { sectionContainer, settingsActionButton, settingsGroup, settingsGroups, settingsPlaceholder, settingsRow, settingsSelect } from "./shared"

// Settings › This Mac (app/settings/MacSection.tsx), in Kanna for Mac only:
// the setup wizard's This Mac step, for after setup. The app does each thing
// and reports the live state back (macos/src/mac-setup.ts) on the
// `kanna:mac-setup` event; the section asks for it every second while it is
// open, so a switch flipped in System Settings shows here too.

const QUIT_BEHAVIOR_OPTIONS: { value: MacQuitBehavior; label: string }[] = [
  { value: "ask", label: "Ask" },
  { value: "keepOnline", label: "Keep Running" },
  { value: "goOffline", label: "Stop Kanna" },
]

/** MacSetupStep's FULL_DISK_ACCESS_STEPS. */
const FULL_DISK_ACCESS_STEPS = "Click +, then choose Kanna."

const State = opaque<MacSetupState>("MacSetupState")

export const Model = Schema.Struct({
  state: Schema.NullOr(State),
  quitBehavior: Select.Model,
})
export type Model = typeof Model.Type

export function init(): Model {
  return {
    // useMacSetupStore's initial value: whatever the app handed the page.
    state: typeof window !== "undefined" ? window.__kannaMacSetup ?? null : null,
    quitBehavior: Select.init({ id: "settings-mac-quit-behavior" }),
  }
}

export const Message = defineMessageUnion({
  MountedSection: {},
  UnmountedSection: {},
  ReceivedMacSetupState: { state: State },
  ClickedOpenLoginItems: {},
  ToggledLoginItem: { checked: Schema.Boolean },
  ToggledKeepAwake: { checked: Schema.Boolean },
  ToggledKeepAwakeOnBattery: { checked: Schema.Boolean },
  ClickedOpenFullDiskAccess: {},
  GotQuitBehaviorMessage: { message: Select.Message },
  CompletedMacSetupRequest: {},
})
export type Message = typeof Message.Type

type Return = SectionReturn<Model, Message>

/** One request to the app; it answers with the new state (`kanna:mac-setup`). */
const PostMacSetup = Command.define("PostMacSetup", {
  args: {
    request: Schema.Union([
      Schema.TaggedStruct("Refresh", {}),
      Schema.TaggedStruct("OpenLoginItems", {}),
      Schema.TaggedStruct("SetLoginItem", { enabled: Schema.Boolean }),
      Schema.TaggedStruct("SetKeepAwake", { onPower: Schema.optional(Schema.Boolean), onBattery: Schema.optional(Schema.Boolean) }),
      Schema.TaggedStruct("OpenFullDiskAccess", {}),
      Schema.TaggedStruct("SetQuitBehavior", { value: Schema.String }),
    ]),
  },
  messages: [Message.CompletedMacSetupRequest],
  execute: ({ request }) => Effect.sync(() => {
    switch (request._tag) {
      case "Refresh": macSetup.refresh(); break
      case "OpenLoginItems": macSetup.openLoginItems(); break
      case "SetLoginItem": macSetup.setLoginItem(request.enabled); break
      case "SetKeepAwake": macSetup.setKeepAwake({
        ...(request.onPower !== undefined ? { onPower: request.onPower } : {}),
        ...(request.onBattery !== undefined ? { onBattery: request.onBattery } : {}),
      }); break
      case "OpenFullDiskAccess": macSetup.openFullDiskAccess(); break
      case "SetQuitBehavior": macSetup.setQuitBehavior(request.value as MacQuitBehavior); break
    }
    return Message.CompletedMacSetupRequest()
  }),
})

export function update(model: Model, message: Message, _app: AppModel): Return {
  return Message.match<Return>(message, {
    MountedSection: () => ({ model, commands: [PostMacSetup({ request: { _tag: "Refresh" } })] }),
    UnmountedSection: () => ({ model: init() }),
    ReceivedMacSetupState: ({ state }) => ({ model: { ...model, state } }),
    ClickedOpenLoginItems: () => ({ model, commands: [PostMacSetup({ request: { _tag: "OpenLoginItems" } })] }),
    ToggledLoginItem: ({ checked }) => ({ model, commands: [PostMacSetup({ request: { _tag: "SetLoginItem", enabled: checked } })] }),
    ToggledKeepAwake: ({ checked }) => ({ model, commands: [PostMacSetup({ request: { _tag: "SetKeepAwake", onPower: checked } })] }),
    ToggledKeepAwakeOnBattery: ({ checked }) => ({ model, commands: [PostMacSetup({ request: { _tag: "SetKeepAwake", onBattery: checked } })] }),
    ClickedOpenFullDiskAccess: () => ({ model, commands: [PostMacSetup({ request: { _tag: "OpenFullDiskAccess" } })] }),
    GotQuitBehaviorMessage: ({ message: child }) => {
      const lifted = liftChild(
        Select.update(model.quitBehavior, child),
        (quitBehavior) => ({ ...model, quitBehavior }),
        (selectMessage) => Message.GotQuitBehaviorMessage({ message: selectMessage }),
      )
      const commands = lifted.outMessage
        ? [...lifted.commands, PostMacSetup({ request: { _tag: "SetQuitBehavior", value: lifted.outMessage.value } })]
        : lifted.commands
      return { model: lifted.model, commands }
    },
    CompletedMacSetupRequest: () => ({ model }),
  })
}

/** While the section is open (the page gates it): the app's answers, and a refresh every second. */
export const subscriptions = Subscription.make<Model, Message>()(() => ({
  state: Subscription.persistentEntry(
    Dom.streamFromEvent({
      target: window as Dom.TypedEventTarget<{ "kanna:mac-setup": CustomEvent<MacSetupState> }>,
      type: "kanna:mac-setup",
      mapEvent: (event) => Message.ReceivedMacSetupState({ state: event.detail }),
    }) as Stream.Stream<Message>,
  ),
  refresh: Subscription.persistentEntry(
    Stream.tick(Duration.seconds(1)).pipe(
      Stream.drop(1),
      Stream.mapEffect(() => Effect.sync(() => {
        macSetup.refresh()
        return Message.CompletedMacSetupRequest()
      })),
    ),
  ),
}))

const renderQuitBehavior = (value: string) => [QUIT_BEHAVIOR_OPTIONS.find((option) => option.value === value)?.label ?? value]

const SectionMount = makeSectionMount("SettingsMacSection", Message.MountedSection, () => Message.MountedSection())

export const view = Submodel.defineView<Model, Message, SectionViewInputs>((model, { switched }, h) => {
  const state = model.state
  const container = (children: ReadonlyArray<ReturnType<typeof h.div>>) => sectionContainer({
    sectionId: "mac",
    switched,
    mount: SectionMount(),
    unmounted: Message.UnmountedSection(),
    label: sectionLabel("mac"),
    subtitle: sectionSubtitle("mac"),
  }, children, h)

  if (!state) {
    return container([settingsPlaceholder({ loading: true }, ["Checking this Mac…"], h)])
  }

  return container([
    settingsGroups([
      settingsGroup({ title: ["Staying Online"] }, [
        settingsRow({
          def: SETTINGS_ROWS.openAtLogin,
          ...(state.loginItem === "requiresApproval"
            ? { description: ["macOS wants this approved: turn Kanna on under Login Items to finish."] }
            : {}),
        }, [
          state.loginItem === "requiresApproval"
            ? settingsActionButton({ onClick: Message.ClickedOpenLoginItems() }, ["Open Login Items"], h)
            : switchControl({
              checked: state.loginItem === "enabled",
              onCheckedChange: (checked) => Message.ToggledLoginItem({ checked }),
              ariaLabel: SETTINGS_ROWS.openAtLogin.title,
            }, h),
        ], h),
        settingsRow({
          def: SETTINGS_ROWS.keepAwake,
          description: [
            SETTINGS_ROWS.keepAwake.description,
            state.lidClosingSleeps
              ? h.span([h.Class("mt-1 block text-amber-600 dark:text-amber-400")], [
                "Closing the lid sleeps this Mac. Keep it open, or connect a display to run it closed.",
              ])
              : null,
          ],
        }, [
          switchControl({
            checked: state.keepAwakeOnPower,
            onCheckedChange: (checked) => Message.ToggledKeepAwake({ checked }),
            ariaLabel: SETTINGS_ROWS.keepAwake.title,
          }, h),
        ], h),
        settingsRow({
          def: SETTINGS_ROWS.keepAwakeOnBattery,
          nested: true,
          ...(!state.pluggedIn && !state.keepAwakeOnBattery
            ? { description: ["On battery now: this Mac sleeps when idle until it's plugged in."] }
            : {}),
        }, [
          // Shows what's in effect: with Keep Awake off, nothing stays awake
          // on battery either, so this slides off. The saved choice is
          // kept, and it slides back on with Keep Awake.
          switchControl({
            checked: state.keepAwakeOnPower && state.keepAwakeOnBattery,
            disabled: !state.keepAwakeOnPower,
            onCheckedChange: (checked) => Message.ToggledKeepAwakeOnBattery({ checked }),
            ariaLabel: SETTINGS_ROWS.keepAwakeOnBattery.title,
          }, h),
        ], h),
        state.quitBehavior
          ? settingsRow({ def: SETTINGS_ROWS.quitBehavior }, [
            settingsSelect({
              slotId: "quit-behavior",
              model: model.quitBehavior,
              value: state.quitBehavior,
              items: QUIT_BEHAVIOR_OPTIONS,
              renderItem: renderQuitBehavior,
              toParentMessage: (message) => Message.GotQuitBehaviorMessage({ message }),
            }, h),
          ], h)
          : null,
      ], h),

      settingsGroup({ title: ["Permissions"] }, [
        settingsRow({
          def: SETTINGS_ROWS.fullDiskAccess,
          alignStart: true,
          description: [
            SETTINGS_ROWS.fullDiskAccess.description,
            state.fullDiskAccess ? null : h.span([h.Class("mt-1 block")], [FULL_DISK_ACCESS_STEPS]),
          ],
        }, [
          state.fullDiskAccess
            ? h.span([h.Class("flex items-center gap-1.5 text-sm text-muted-foreground")], [
              Check({ class: "h-4 w-4 text-emerald-500" }, h),
              "Granted",
            ])
            : settingsActionButton({ onClick: Message.ClickedOpenFullDiskAccess() }, ["Open Privacy Settings"], h),
        ], h),
      ], h),
    ], h),
  ])
})
