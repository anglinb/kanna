import { defineConfig } from "vite"
import { foldkit } from "@foldkit/vite-plugin"
import { getDefaultDevServerPort } from "./src/shared/dev-ports"
import { DEV_CLIENT_PORT } from "./src/shared/ports"

function getBackendTargetHost() {
  return process.env.KANNA_DEV_BACKEND_TARGET_HOST || "127.0.0.1"
}

function getBackendPort() {
  const configured = Number(process.env.KANNA_DEV_BACKEND_PORT)
  return Number.isFinite(configured) && configured > 0 ? configured : getDefaultDevServerPort(DEV_CLIENT_PORT)
}

const backendTargetHost = getBackendTargetHost()
const backendPort = getBackendPort()

export default defineConfig({
  plugins: [foldkit()],
  server: {
    host: "0.0.0.0",
    port: DEV_CLIENT_PORT,
    strictPort: true,
    // Test artifacts and builds aren't the app: a full parity run leaves
    // tens of thousands of files, past the system's limit on file watchers.
    watch: { ignored: ["**/.parity/**", "**/.e2e/**", "**/dist/**", "**/.claude/**"] },
    proxy: {
      "/ws": {
        target: `ws://${backendTargetHost}:${backendPort}`,
        ws: true,
      },
      "/api": {
        target: `http://${backendTargetHost}:${backendPort}`,
      },
      "/health": {
        target: `http://${backendTargetHost}:${backendPort}`,
      },
      "/auth": {
        target: `http://${backendTargetHost}:${backendPort}`,
      },
    },
    allowedHosts: true,
  },
  build: {
    outDir: "dist/client",
    emptyOutDir: true,
  },
})
