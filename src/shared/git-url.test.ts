import { describe, expect, test } from "bun:test"
import { buildRepoBrowseUrl, getRepoHostLabel, getRepoUrlLabel } from "./git-url"

describe("buildRepoBrowseUrl", () => {
  test("turns every transport for the same repo into the same page", () => {
    // How you clone it is not where you read it. All four of these are one repo.
    for (const remote of [
      "git@github.com:acme/widgets.git",
      "ssh://git@github.com/acme/widgets.git",
      "https://github.com/acme/widgets.git",
      "https://github.com/acme/widgets",
    ]) {
      expect(buildRepoBrowseUrl(remote)).toEqual({
        url: "https://github.com/acme/widgets",
        host: "github.com",
      })
    }
  })

  test("keeps the host it was given rather than assuming GitHub", () => {
    expect(buildRepoBrowseUrl("git@gitlab.com:acme/widgets.git")?.url)
      .toBe("https://gitlab.com/acme/widgets")
    expect(buildRepoBrowseUrl("https://git.internal/acme/widgets.git")?.host)
      .toBe("git.internal")
  })

  test("keeps nested group paths, which GitLab addresses with", () => {
    expect(buildRepoBrowseUrl("https://gitlab.com/acme/tools/widgets.git")?.url)
      .toBe("https://gitlab.com/acme/tools/widgets")
  })

  test("drops the ssh port, which means nothing over https", () => {
    expect(buildRepoBrowseUrl("ssh://git@github.com:2222/acme/widgets.git")?.url)
      .toBe("https://github.com/acme/widgets")
  })

  test("refuses to guess when there is no page to guess at", () => {
    // A local remote has directories, not an owner and repo; a host with one
    // path segment isn't a repo either. Null lets the caller drop the action
    // rather than offer a link to a 404.
    expect(buildRepoBrowseUrl("/srv/git/widgets.git")).toBeNull()
    expect(buildRepoBrowseUrl("https://github.com/acme")).toBeNull()
    expect(buildRepoBrowseUrl("not a url")).toBeNull()
    expect(buildRepoBrowseUrl(undefined)).toBeNull()
    expect(buildRepoBrowseUrl("   ")).toBeNull()
  })
})

describe("getRepoHostLabel", () => {
  test("brands the forges people name, and calls the rest by host", () => {
    expect(getRepoHostLabel("github.com")).toBe("GitHub")
    expect(getRepoHostLabel("GitHub.com")).toBe("GitHub")
    expect(getRepoHostLabel("gitlab.com")).toBe("GitLab")
    expect(getRepoHostLabel("bitbucket.org")).toBe("Bitbucket")
    // On a self-hosted forge the host *is* the recognisable name.
    expect(getRepoHostLabel("git.internal")).toBe("git.internal")
  })
})

describe("getRepoUrlLabel", () => {
  test("reads the forge out of a browse URL", () => {
    expect(getRepoUrlLabel("https://github.com/acme/widgets")).toBe("GitHub")
    expect(getRepoUrlLabel("https://gitlab.com/acme/widgets")).toBe("GitLab")
  })

  test("stays neutral rather than claiming GitHub about something unread", () => {
    expect(getRepoUrlLabel(undefined)).toBe("Remote Repo")
    expect(getRepoUrlLabel("nonsense")).toBe("Remote Repo")
  })
})
