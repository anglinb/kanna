import { Effect, FileSystem, Schema } from "effect"
import { getDataRootDir } from "../shared/branding"
import { CLOUD_ENABLED_ENV_VAR, resolveCloudEnabled } from "../shared/server-capabilities"
import { Machine } from "./platform/machine"

export interface RuntimePolicy { readonly cloudEnabled: boolean }
export class RuntimePolicyError extends Schema.TaggedError<RuntimePolicyError>()(
  "@kanna/server/RuntimePolicyError", { message: Schema.String },
) {}

/** Startup-only configuration. Never reads cloud.json or constructs a cloud client. */
export const readRuntimePolicy = Effect.fn("RuntimePolicy.read")(function* (cliOverride?: boolean) {
  const machine = yield* Machine
  const env = machine.env.snapshot()
  const environmentValue = env[CLOUD_ENABLED_ENV_VAR]
  let configText: string | undefined
  if (cliOverride === undefined && !environmentValue?.trim()) {
    const fs = yield* FileSystem.FileSystem
    const file = `${getDataRootDir(machine.homeDirectory, env)}/config.json`
    configText = yield* fs.readFileString(file).pipe(
      Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed(undefined)),
      Effect.catchTag("PlatformError", () => Effect.fail(new RuntimePolicyError({ message: `Could not read ${file}.` }))),
    )
  }
  return yield* Effect.try({
    try: () => ({ cloudEnabled: resolveCloudEnabled(configText, environmentValue, cliOverride) }),
    catch: (cause) => new RuntimePolicyError({ message: cause instanceof Error ? cause.message : String(cause) }),
  })
})
