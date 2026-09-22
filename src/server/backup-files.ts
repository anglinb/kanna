import { constants } from "node:fs"
import { lstat, mkdir, open, readdir, writeFile, type FileHandle } from "node:fs/promises"
import path from "node:path"
import type { SnapshotFile } from "./events"
import { getProjectUploadDir } from "./paths"

/** Pin inodes and byte lengths while the store write queue is held, without copying file contents. */
export async function prepareBackupFiles(dataDir: string, destination: string, snapshot: SnapshotFile) {
  const files: Array<{ handle: FileHandle; target: string; size: number }> = []
  const close = async () => { await Promise.all(files.map(({ handle }) => handle.close())) }
  const pinTree = async (source: string, target: string) => {
    let info
    try { info = await lstat(source) } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return
      throw error
    }
    if (info.isSymbolicLink()) throw new Error("Backup source contains a symbolic link")
    if (info.isDirectory()) {
      for (const name of await readdir(source)) await pinTree(path.join(source, name), path.join(target, name))
    } else if (info.isFile()) {
      const handle = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW)
      try {
        const pinned = await handle.stat()
        if (!pinned.isFile()) throw new Error("Backup source is not a regular file")
        files.push({ handle, target, size: pinned.size })
      } catch (error) { await handle.close(); throw error }
    }
  }
  try {
    // Explicit allowlist: settings and credentials never enter the archive.
    for (const name of ["transcripts", "media"]) await pinTree(path.join(dataDir, name), path.join(destination, name))
    for (const project of snapshot.projects) {
      await pinTree(getProjectUploadDir(project.localPath), path.join(destination, "project-uploads", project.id))
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
