import { describe, expect, test } from "bun:test"
import {
  fetchLatestRcVersion,
  installRcVersion,
  nextRcVersion,
  parseRcTag,
  pickLatestRcVersion,
  rcTarballAssetName,
  rcTarballUrl,
} from "./rc-channel"

describe("rc release tags", () => {
  test("reads the version out of an rc tag and ignores anything else", () => {
    expect(parseRcTag("v0.66.0-rc.1")).toBe("0.66.0-rc.1")
    expect(parseRcTag("  v0.66.0-rc.12  ")).toBe("0.66.0-rc.12")
    // Upstream's stable tags share the repo shape but are not our channel.
    expect(parseRcTag("v0.66.0")).toBeNull()
    expect(parseRcTag("v0.66.0-nightly.abc1234")).toBeNull()
    expect(parseRcTag("not-a-tag")).toBeNull()
  })

  test("orders candidates numerically, not as strings", () => {
    expect(pickLatestRcVersion(["v0.66.0-rc.2", "v0.66.0-rc.10"])).toBe("0.66.0-rc.10")
    expect(pickLatestRcVersion(["v0.66.0-rc.9", "v0.67.0-rc.1", "v0.66.0"])).toBe("0.67.0-rc.1")
    expect(pickLatestRcVersion(["v0.66.0", "garbage"])).toBeNull()
  })

  test("derives the asset name and URL from the version alone", () => {
    expect(rcTarballAssetName("0.66.0-rc.3")).toBe("anglinb-kanna-rc-0.66.0-rc.3.tgz")
    expect(rcTarballUrl("0.66.0-rc.3")).toBe(
      "https://github.com/anglinb/kanna/releases/download/v0.66.0-rc.3/anglinb-kanna-rc-0.66.0-rc.3.tgz",
    )
  })
})

describe("nextRcVersion", () => {
  test("starts at rc.1 for a base version with no candidates yet", () => {
    expect(nextRcVersion("0.66.0", [])).toBe("0.66.0-rc.1")
    expect(nextRcVersion("0.66.0", ["v0.65.0-rc.4"])).toBe("0.66.0-rc.1")
  })

  test("advances past the highest candidate for the same base", () => {
    expect(nextRcVersion("0.66.0", ["v0.66.0-rc.1", "v0.66.0-rc.2"])).toBe("0.66.0-rc.3")
    // Numeric, so rc.10 does not lose to rc.9.
    expect(nextRcVersion("0.66.0", ["v0.66.0-rc.9", "v0.66.0-rc.10"])).toBe("0.66.0-rc.11")
  })

  test("ignores other bases, stable tags and junk", () => {
    const tags = ["v0.67.0-rc.8", "v0.66.0", "v0.66.0-rc.2", "random", "v0.66.0-nightly.abc1234"]
    expect(nextRcVersion("0.66.0", tags)).toBe("0.66.0-rc.3")
  })

  test("normalizes the base version it is handed", () => {
    expect(nextRcVersion("v0.66.0", [])).toBe("0.66.0-rc.1")
    // A checkout that somehow already carries a stamp still resolves to its base.
    expect(nextRcVersion("0.66.0-rc.4", ["v0.66.0-rc.4"])).toBe("0.66.0-rc.5")
  })
})

describe("fetchLatestRcVersion", () => {
  const respondWith = (payload: unknown, ok = true, status = 200) =>
    (async () => ({ ok, status, json: async () => payload })) as unknown as typeof fetch

  test("picks the newest published candidate", async () => {
    const fetchImpl = respondWith([
      { tag_name: "v0.66.0-rc.1" },
      { tag_name: "v0.66.0-rc.3" },
      { tag_name: "v0.66.0-rc.2" },
    ])
    expect(await fetchLatestRcVersion(fetchImpl)).toBe("0.66.0-rc.3")
  })

  test("skips drafts, which are not installable yet", async () => {
    const fetchImpl = respondWith([
      { tag_name: "v0.66.0-rc.5", draft: true },
      { tag_name: "v0.66.0-rc.4" },
    ])
    expect(await fetchLatestRcVersion(fetchImpl)).toBe("0.66.0-rc.4")
  })

  test("reports a useful error when there is nothing to install", async () => {
    await expect(fetchLatestRcVersion(respondWith([{ tag_name: "v0.66.0" }])))
      .rejects.toThrow(/no release candidates/)
    await expect(fetchLatestRcVersion(respondWith([], false, 404)))
      .rejects.toThrow(/GitHub returned 404/)
  })
})

describe("installRcVersion", () => {
  const stubDeps = (options: {
    installedVersions: Array<string | null>
    failInstall?: boolean
  }) => {
    const commands: string[][] = []
    const installedVersions = [...options.installedVersions]
    return {
      commands,
      deps: {
        hasCommandImpl: () => true,
        repairGlobalManifest: () => false,
        readInstalledVersion: () => installedVersions.shift() ?? null,
        run: (command: string, args: string[]) => {
          commands.push([command, ...args])
          const isInstall = args[0] === "install"
          return { ok: isInstall ? !options.failInstall : true, output: "" }
        },
      },
    }
  }

  test("removes the existing global entry before installing", () => {
    // Bun aborts with DependencyLoop when a global entry moves from one
    // tarball spec to another in place, so the remove is load-bearing.
    const { commands, deps } = stubDeps({ installedVersions: ["0.66.0-rc.1", "0.66.0-rc.2"] })

    const result = installRcVersion("0.66.0-rc.2", deps)

    expect(result.ok).toBe(true)
    expect(commands).toEqual([
      ["bun", "remove", "-g", "@anglinb/kanna-rc"],
      ["bun", "install", "-g", rcTarballUrl("0.66.0-rc.2")],
    ])
  })

  test("rolls back to the previous build when the install fails", () => {
    const { commands, deps } = stubDeps({ installedVersions: ["0.66.0-rc.1"], failInstall: true })

    const result = installRcVersion("0.66.0-rc.2", deps)

    expect(result.ok).toBe(false)
    // A failed install would otherwise leave the machine with no kanna-rc,
    // because the entry was already removed.
    expect(commands.at(-1)).toEqual(["bun", "install", "-g", rcTarballUrl("0.66.0-rc.1")])
  })

  test("fails when the install silently does not replace the package", () => {
    // `bun install -g` can exit 0 without swapping the package.
    const { deps } = stubDeps({ installedVersions: ["0.66.0-rc.1", "0.66.0-rc.1"] })

    const result = installRcVersion("0.66.0-rc.2", deps)

    expect(result.ok).toBe(false)
    expect(result.userMessage).toContain("reports 0.66.0-rc.1 instead of 0.66.0-rc.2")
  })

  test("reports a missing bun instead of pretending to install", () => {
    const result = installRcVersion("0.66.0-rc.1", { hasCommandImpl: () => false })

    expect(result.ok).toBe(false)
    expect(result.errorCode).toBe("command_missing")
  })
})
