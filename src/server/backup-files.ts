import { constants, copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, writeFileSync } from "node:fs"
import path from "node:path"
import type { SnapshotFile } from "./events"
import { getProjectUploadDir } from "./paths"

/** Called inside the store write queue, without yielding, so headers and payloads agree. */
export function captureBackupFiles(dataDir: string, destination: string, snapshot: SnapshotFile) {
  mkdirSync(destination, { recursive: true, mode: 0o700 })
  const copyTree = (source: string, target: string) => {
    if (!existsSync(source)) return
    const info = lstatSync(source)
    if (info.isSymbolicLink()) throw new Error("Backup source contains a symbolic link")
    if (info.isDirectory()) {
      mkdirSync(target, { recursive: true, mode: 0o700 })
      for (const name of readdirSync(source)) copyTree(path.join(source, name), path.join(target, name))
    } else if (info.isFile()) {
      mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 })
      copyFileSync(source, target, constants.COPYFILE_FICLONE)
    }
  }
  writeFileSync(path.join(destination, "snapshot.json"), JSON.stringify(snapshot), { mode: 0o600 })
  // Explicit allowlist: settings, API keys and provider/backup credentials never enter the archive.
  for (const name of ["transcripts", "media", "sidebar-order.json"]) {
    copyTree(path.join(dataDir, name), path.join(destination, name))
  }
  for (const project of snapshot.projects) {
    copyTree(getProjectUploadDir(project.localPath), path.join(destination, "project-uploads", project.id))
  }
}
