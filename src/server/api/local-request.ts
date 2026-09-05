/**
 * "Did this request come from a process on this machine, directly?"
 *
 * The one credential that must never travel is the internal API key Kanna
 * mints for its own agent bridge (kanna-mcp-bridge.ts). It is accepted only on
 * requests that pass this check, which is what keeps `/api/v1` — always
 * mounted for the bridge — invisible to the network without `--api`.
 *
 * `CloudRequestClass` is not enough on its own. It answers "did this come
 * through the kanna.sh proxy", and reports plain "local" for every request
 * when no cloud runtime is attached — including one that arrived over the LAN
 * because the user bound `--remote`. So the peer address is checked directly.
 *
 * The peer address alone is not enough either: under `--share`, cloudflared
 * runs on this machine and connects to the server from 127.0.0.1, so every
 * request off the public tunnel looks like loopback. What distinguishes them
 * is the forwarding headers a tunnel or reverse proxy adds and a locally
 * spawned child process never does — so any of those disqualifies a request,
 * regardless of where it appears to come from.
 */

/** Headers that mean "this was relayed", whatever the socket says. */
const FORWARDING_HEADERS = [
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-proto",
  "x-real-ip",
  "forwarded",
  "cf-connecting-ip",
  "cf-ray",
]

export function isLoopbackAddress(address: string | null | undefined) {
  if (!address) return false
  // Bun reports IPv6-mapped IPv4 as ::ffff:127.0.0.1.
  const normalized = address.startsWith("::ffff:") ? address.slice("::ffff:".length) : address
  return normalized === "127.0.0.1" || normalized === "::1" || normalized.startsWith("127.")
}

export function isDirectLocalRequest(req: Request, peerAddress: string | null | undefined) {
  if (!isLoopbackAddress(peerAddress)) return false
  return !FORWARDING_HEADERS.some((header) => req.headers.has(header))
}
