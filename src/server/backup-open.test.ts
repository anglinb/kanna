import { expect, test } from "bun:test"
import { mkdtemp, mkdir, open, rename, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { openBackupChild } from "./backup-open"

test("ancestor replacement cannot redirect a child open through a pinned directory", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "kanna-backup-open-"))
  try {
    await mkdir(path.join(root, "uploads"))
    await mkdir(path.join(root, "private"))
    await writeFile(path.join(root, "uploads/file"), "allowed")
    await writeFile(path.join(root, "private/file"), "secret")
    const parent = await open(path.join(root, "uploads"), "r")
    try {
      await rename(path.join(root, "uploads"), path.join(root, "moved"))
      await symlink(path.join(root, "private"), path.join(root, "uploads"))
      const child = openBackupChild(parent.fd, "file")!
      try {
        const buffer = Buffer.alloc(32)
        const { bytesRead } = await child.read(buffer, 0, buffer.length, 0)
        expect(buffer.subarray(0, bytesRead).toString()).toBe("allowed")
      } finally { await child.close() }
      await symlink(path.join(root, "private/file"), path.join(root, "moved/link"))
      expect(() => openBackupChild(parent.fd, "link")).toThrow("symbolic links")
      expect(() => openBackupChild(parent.fd, "../private/file")).toThrow("invalid name")
    } finally { await parent.close() }
  } finally { await rm(root, { recursive: true, force: true }) }
})
