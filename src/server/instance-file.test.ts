import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import {
  mintInstanceToken,
  readInstanceFile,
  removeInstanceFile,
  writeInstanceFile,
  type InstanceFile,
} from "./instance-file"

let dir: string
let filePath: string

const sample: InstanceFile = {
  port: 3000,
  url: "http://127.0.0.1:3000",
  token: "abc123",
  pid: 42,
  instance: "fingerprint",
  startedAt: 1_700_000_000_000,
}

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "kanna-instance-"))
  filePath = path.join(dir, "nested", "instance.json")
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe("mintInstanceToken", () => {
  test("produces a long random hex token that differs each call", () => {
    const a = mintInstanceToken()
    const b = mintInstanceToken()
    expect(a).toMatch(/^[0-9a-f]{64}$/)
    expect(a).not.toBe(b)
  })
})

describe("writeInstanceFile", () => {
  test("creates parent directories and round-trips", async () => {
    await writeInstanceFile(sample, filePath)
    expect(await readInstanceFile(filePath)).toEqual(sample)
  })

  test("is owner-read/write only — the token is a capability", async () => {
    await writeInstanceFile(sample, filePath)
    expect((await stat(filePath)).mode & 0o777).toBe(0o600)
  })

  test("overwrites a stale file from a previous run", async () => {
    await writeInstanceFile(sample, filePath)
    await writeInstanceFile({ ...sample, port: 3111, token: "fresh" }, filePath)

    const read = await readInstanceFile(filePath)
    expect(read?.port).toBe(3111)
    expect(read?.token).toBe("fresh")
  })
})

describe("readInstanceFile", () => {
  test("returns null when there is no file", async () => {
    expect(await readInstanceFile(filePath)).toBeNull()
  })

  test("returns null for unparseable or incomplete contents", async () => {
    const broken = path.join(dir, "broken.json")

    await writeFile(broken, "{ not json")
    expect(await readInstanceFile(broken)).toBeNull()

    await writeFile(broken, JSON.stringify({ port: 3000 }))
    expect(await readInstanceFile(broken)).toBeNull()

    await writeFile(broken, JSON.stringify({ ...sample, token: "" }))
    expect(await readInstanceFile(broken)).toBeNull()

    await writeFile(broken, JSON.stringify({ ...sample, port: "3000" }))
    expect(await readInstanceFile(broken)).toBeNull()
  })

  test("tolerates missing optional metadata", async () => {
    const partial = path.join(dir, "partial.json")
    await writeFile(partial, JSON.stringify({ port: 1, url: "http://x", token: "t" }))

    expect(await readInstanceFile(partial)).toEqual({
      port: 1,
      url: "http://x",
      token: "t",
      pid: 0,
      instance: "",
      startedAt: 0,
    })
  })
})

describe("removeInstanceFile", () => {
  test("deletes the file and is safe to call twice", async () => {
    await writeInstanceFile(sample, filePath)
    await removeInstanceFile(filePath)
    await removeInstanceFile(filePath)
    expect(await readInstanceFile(filePath)).toBeNull()
  })
})
