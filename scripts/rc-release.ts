import process from "node:process"
import { appendFileSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import { RC_PACKAGE_NAME } from "../src/shared/branding"
import { nextRcVersion, rcTag, rcTarballAssetName, RC_RELEASE_REPO } from "../src/server/rc-channel"

// Stamps the checkout as a release-candidate build, ready for `bun pm pack`.
// Run by .github/workflows/rc-release.yml *before* the build, because the
// client bundle embeds the version from package.json.
//
// The stamped package.json is never committed — see nextRcVersion for why the
// RC version is derived at build time instead of tracked in the repo.

const DRY_RUN = process.argv.includes("--dry-run")
const packageJsonPath = path.resolve(import.meta.dir, "../package.json")

interface PackageJson {
  name: string
  version: string
  bin?: Record<string, string>
  [key: string]: unknown
}

async function fetchReleaseTags(repo: string): Promise<string[]> {
  const token = process.env.GITHUB_TOKEN?.trim()
  const response = await fetch(`https://api.github.com/repos/${repo}/releases?per_page=100`, {
    headers: {
      Accept: "application/vnd.github+json",
      "User-Agent": "kanna",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  })
  if (!response.ok) {
    throw new Error(`GitHub returned ${response.status} listing ${repo} releases`)
  }
  const payload = await response.json() as Array<{ tag_name?: unknown }>
  // Drafts count too: a draft already holds its tag name, so skipping them
  // could hand the same RC number out twice.
  return payload.map((release) => (typeof release.tag_name === "string" ? release.tag_name : ""))
}

const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8")) as PackageJson
const repo = process.env.GITHUB_REPOSITORY?.trim() || RC_RELEASE_REPO
const version = nextRcVersion(packageJson.version, await fetchReleaseTags(repo))
const tag = rcTag(version)
const tarball = rcTarballAssetName(version)

const stamped: PackageJson = {
  ...packageJson,
  name: RC_PACKAGE_NAME,
  version,
  // Ship only the RC command. Keeping `kanna` here would put the fork's build
  // on the stable command's name and clobber a teammate's real install.
  bin: { "kanna-rc": "./bin/kanna-rc" },
}

console.log(`${packageJson.name}@${packageJson.version} → ${stamped.name}@${version}`)
console.log(`tag: ${tag}`)
console.log(`tarball: ${tarball}`)

if (DRY_RUN) {
  console.log("(dry run — package.json not modified)")
} else {
  writeFileSync(packageJsonPath, `${JSON.stringify(stamped, null, 2)}\n`)
}

const githubOutput = process.env.GITHUB_OUTPUT
if (githubOutput) {
  appendFileSync(githubOutput, `version=${version}\ntag=${tag}\ntarball=${tarball}\n`)
}
