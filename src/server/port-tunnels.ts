import { startShareTunnel, type StartedShareTunnel } from "./share"

/**
 * One cloudflared quick tunnel per exposed local port.
 *
 * The browser panel's iframe points at `http://localhost:<port>`, which in
 * cloud mode resolves to the viewer's own machine. A quick tunnel gives the
 * port a public https URL that works from anywhere. Nothing here persists:
 * the tunnels are child processes, so they die with the server, and a
 * forgotten public share is the main risk of this feature.
 *
 * Anyone with the URL can reach the port. trycloudflare hostnames are random
 * words, not an auth scheme.
 */

export interface ExposedPort {
  port: number
  publicUrl: string
}

export interface PortTunnelManagerDeps {
  startTunnel?: (localUrl: string) => Promise<StartedShareTunnel>
  log?: (message: string) => void
}

function assertValidPort(port: number) {
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error("Port is invalid.")
  }
}

export class PortTunnelManager {
  private readonly tunnels = new Map<number, { publicUrl: string; stop: () => void }>()
  private readonly pending = new Map<number, Promise<ExposedPort>>()
  private readonly startTunnel: (localUrl: string) => Promise<StartedShareTunnel>
  private readonly log: (message: string) => void

  constructor(deps: PortTunnelManagerDeps = {}) {
    this.startTunnel = deps.startTunnel ?? ((localUrl) => startShareTunnel(localUrl, "quick", { log: deps.log }))
    this.log = deps.log ?? (() => {})
  }

  getPublicUrl(port: number) {
    return this.tunnels.get(port)?.publicUrl
  }

  list(): ExposedPort[] {
    return [...this.tunnels.entries()].map(([port, tunnel]) => ({ port, publicUrl: tunnel.publicUrl }))
  }

  /**
   * Start a tunnel for the port, or return the one already running. A second
   * call while the first is still connecting shares that attempt instead of
   * spawning a second cloudflared.
   */
  async expose(port: number): Promise<ExposedPort> {
    assertValidPort(port)
    const running = this.tunnels.get(port)
    if (running) return { port, publicUrl: running.publicUrl }
    const inFlight = this.pending.get(port)
    if (inFlight) return inFlight

    const attempt = this.startTunnel(`http://localhost:${port}`)
      .then((tunnel) => {
        if (!tunnel.publicUrl) {
          tunnel.stop()
          throw new Error(`Cloudflare tunnel for port ${port} started without a public URL.`)
        }
        const record = { publicUrl: tunnel.publicUrl, stop: tunnel.stop }
        this.tunnels.set(port, record)
        this.log(`exposed port ${port} at ${tunnel.publicUrl}`)
        // cloudflared can die on its own (rate limit, network). Drop the
        // record so the panel stops showing a URL that no longer answers.
        void tunnel.exited?.then(() => {
          if (this.tunnels.get(port) === record) {
            this.tunnels.delete(port)
            this.log(`tunnel for port ${port} exited`)
          }
        })
        return { port, publicUrl: tunnel.publicUrl }
      })
      .finally(() => {
        this.pending.delete(port)
      })

    this.pending.set(port, attempt)
    return attempt
  }

  unexpose(port: number) {
    assertValidPort(port)
    const tunnel = this.tunnels.get(port)
    if (!tunnel) return { ok: true, port }
    this.tunnels.delete(port)
    tunnel.stop()
    this.log(`stopped exposing port ${port}`)
    return { ok: true, port }
  }

  stopAll() {
    for (const port of [...this.tunnels.keys()]) {
      this.unexpose(port)
    }
  }
}
