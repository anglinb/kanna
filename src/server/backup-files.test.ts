import { afterEach, expect, test } from "bun:test"
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { EventStore } from "./event-store"
import type { TranscriptEntry } from "../shared/types"

const dirs: string[] = []
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))) })

test("captures archived chats, full payloads, media and project uploads, without secrets", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "kanna-capture-"))
  dirs.push(root)
  const data = path.join(root, "data")
  const projectPath = path.join(root, "project")
  const store = new EventStore(data)
  await store.initialize()
  const project = await store.openProject(projectPath)
  const chat = await store.createChat(project.id)
  const message: TranscriptEntry = { _id: "prompt", kind: "user_prompt", createdAt: 10, content: "full prompt" }
  const result = { _id: "result", kind: "tool_result", toolId: "t1", createdAt: 11, content: "large payload ".repeat(2000) } as TranscriptEntry
  await store.appendMessage(chat.id, message)
  await store.appendMessage(chat.id, result)
  await store.archiveChat(chat.id)
  await mkdir(path.join(data, "media", chat.id), { recursive: true })
  await writeFile(path.join(data, "media", chat.id, "image.png"), "image bytes")
  await mkdir(path.join(projectPath, ".kanna/uploads"), { recursive: true })
  await writeFile(path.join(projectPath, ".kanna/uploads/file.txt"), "attachment")
  await writeFile(path.join(data, "settings.json"), "private setting")
  await mkdir(path.join(data, "backups"))
  await writeFile(path.join(data, "backups/state.json"), "secret token")
  const destination = path.join(root, "capture")
  await store.captureBackup(destination)
  const restored = new EventStore(destination)
  await restored.initialize()
  expect(restored.getMessages(chat.id)).toEqual([message, result])
  expect(restored.state.chatsById.get(chat.id)?.archivedAt).toBeTruthy()
  expect(await readFile(path.join(destination, "media", chat.id, "image.png"), "utf8")).toBe("image bytes")
  expect(await readFile(path.join(destination, "project-uploads", project.id, "file.txt"), "utf8")).toBe("attachment")
  expect(await readdir(destination)).not.toContain("settings.json")
  expect(await readdir(destination)).not.toContain("backups")
})

test("capture errors do not poison chat writes; symlinks cannot leak unrelated files", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "kanna-capture-"))
  dirs.push(root)
  const store = new EventStore(path.join(root, "data"))
  await store.initialize()
  const project = await store.openProject(path.join(root, "project"))
  const chat = await store.createChat(project.id)
  await mkdir(path.join(root, "data/media"), { recursive: true })
  await writeFile(path.join(root, "secret"), "do not upload")
  await symlink(path.join(root, "secret"), path.join(root, "data/media/leak"))
  await expect(store.captureBackup(path.join(root, "capture"))).rejects.toThrow("symbolic link")
  await store.appendMessage(chat.id, { _id: "still-works", kind: "user_prompt", createdAt: 1, content: "hello" })
  expect(store.getMessages(chat.id)).toHaveLength(1)
})
