import { BunServices } from "@effect/platform-bun"
import { Layer } from "effect"
import { KannaLoggerLayer } from "./logger"

/**
 * What every server-side layer runs on: Bun's file system, path and process
 * services, and Kanna's console logger.
 */
export const ServerPlatform = Layer.merge(BunServices.layer, KannaLoggerLayer)
