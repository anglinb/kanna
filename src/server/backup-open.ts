import { close, constants, fstat, read } from "node:fs"
import { promisify } from "node:util"
import { dlopen, ptr, read as memory } from "bun:ffi"

const closeFd = promisify(close)
const statFd = promisify(fstat)
const readFd = promisify(read)
let native: ReturnType<typeof load> | undefined
function load() {
  if (process.platform !== "darwin" && process.platform !== "linux") throw new Error("Backup capture requires macOS or Linux")
  const errno = process.platform === "darwin" ? "__error" : "__errno_location"
  return dlopen(process.platform === "darwin" ? "/usr/lib/libSystem.B.dylib" : "libc.so.6", {
    openat: { args: ["i32", "ptr", "i32"], returns: "i32" },
    [errno]: { args: [], returns: "ptr" },
  })
}

/** Resolve exactly one child against a pinned parent inode, never a path's ancestors. */
export function openBackupChild(parent: number, name: string) {
  if (!name || name === "." || name === ".." || /[/\\\0]/.test(name)) throw new Error("Backup source has an invalid name")
  const lib = native ??= load()
  const encoded = Buffer.from(`${name}\0`)
  const closeOnExec = process.platform === "darwin" ? 0x1000000 : 0x80000
  const fd = lib.symbols.openat!(parent, ptr(encoded), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK | closeOnExec) as number
  if (fd < 0) {
    const errno = memory.i32(lib.symbols[process.platform === "darwin" ? "__error" : "__errno_location"]!() as ReturnType<typeof ptr>)
    if (errno === 2) return null // ENOENT: optional directory or concurrently removed child.
    throw new Error("Backup source could not be opened without following symbolic links")
  }
  return {
    fd,
    stat: () => statFd(fd),
    close: () => closeFd(fd),
    read: (buffer: Buffer, offset: number, length: number, position: number) => readFd(fd, buffer, offset, length, position),
  }
}
