import { mkdir, open, readdir, writeFile } from "node:fs/promises"
import path from "node:path"
import type { SnapshotFile } from "./events"
import { openBackupChild } from "./backup-open"

/** Pin inodes and byte lengths while the store write queue is held, without copying file contents. */
export async function prepareBackupFiles(dataDir: string, destination: string, snapshot: SnapshotFile) {
  const files: Array<{ handle: NonNullable<ReturnType<typeof openBackupChild>>; target: string; size: number }> = []
  const close = async () => { await Promise.all(files.map(({ handle }) => handle.close())) }
  const pinTree = async (parent: number, name: string, source: string, target: string) => {
    const handle = openBackupChild(parent, name)
    if (!handle) return
    let retained = false
    try {
      const info = await handle.stat()
      if (info.isDirectory()) {
        // Listing may race with a rename, but it supplies names only. Every
        // child is opened against this pinned directory, so no ancestor path
        // can redirect an open outside the allowlist.
        for (const child of await readdir(source)) await pinTree(handle.fd, child, path.join(source, child), path.join(target, child))
      } else if (info.isFile()) {
        files.push({ handle, target, size: info.size })
        retained = true
      } else throw new Error("Backup source is not a regular file or directory")
    } finally { if (!retained) await handle.close() }
  }
  try {
    const data = await open(dataDir, "r")
    try {
      for (const name of ["transcripts", "media"]) await pinTree(data.fd, name, path.join(dataDir, name), path.join(destination, name))
    } finally { await data.close() }
    for (const project of snapshot.projects) {
      let root
      try { root = await open(project.localPath, "r") } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue
        throw error
      }
      try {
        const kanna = openBackupChild(root.fd, ".kanna")
        if (!kanna) continue
        try { await pinTree(kanna.fd, "uploads", path.join(project.localPath, ".kanna/uploads"), path.join(destination, "project-uploads", project.id)) }
        finally { await kanna.close() }
      } finally { await root.close() }
    }
  } catch (error) { await close(); throw error }

  // The caller releases the write queue before invoking this. Appends after the
  // boundary are excluded by size; deletion/atomic replacement cannot change the
  // pinned inode. Sidebar order comes from the snapshot, not its mutable file.
  return async () => {
    try {
      await mkdir(destination, { recursive: true, mode: 0o700 })
      await writeFile(path.join(destination, "snapshot.json"), JSON.stringify(snapshot), { mode: 0o600 })
      await writeFile(path.join(destination, "sidebar-order.json"), JSON.stringify(snapshot.sidebarProjectOrder ?? []), { mode: 0o600 })
      const buffer = Buffer.alloc(1024 * 1024)
      for (const { handle, target, size } of files) {
        await mkdir(path.dirname(target), { recursive: true, mode: 0o700 })
        const output = await open(target, "wx", 0o600)
        try {
          let offset = 0
          while (offset < size) {
            const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, size - offset), offset)
            if (!bytesRead) throw new Error("Backup source was truncated during capture")
            await output.writeFile(buffer.subarray(0, bytesRead))
            offset += bytesRead
          }
        } finally { await output.close() }
      }
    } finally { await close() }
  }
}
