import { Effect, Layer } from "effect"
import { CloudFeatureDisabled } from "./disabled"
import type { CloudFeatureOptions } from "./feature"

/** Disabled startup never imports the live feature or initializes its dependencies. */
export const cloudFeatureLayer = (enabled: boolean, options: CloudFeatureOptions) => enabled
  ? Layer.unwrap(Effect.promise(() => import("./live")).pipe(Effect.map(({ CloudFeatureLive }) => CloudFeatureLive(options))))
  : CloudFeatureDisabled
