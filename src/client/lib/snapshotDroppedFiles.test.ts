import { describe, expect, test } from "bun:test"
import { snapshotDroppedFiles } from "./snapshotDroppedFiles"

describe("snapshotDroppedFiles", () => {
  test("copies bytes, name, type, and lastModified into new File objects", async () => {
    const original = new File(["hello"], "shot.heic", { type: "image/heic", lastModified: 1234 })
    const [copy] = await snapshotDroppedFiles([original])

    expect(copy).not.toBe(original)
    expect(copy?.name).toBe("shot.heic")
    expect(copy?.type).toBe("image/heic")
    expect(copy?.lastModified).toBe(1234)
    expect(await copy?.text()).toBe("hello")
  })

  test("keeps file order", async () => {
    const files = [
      new File(["a"], "a.txt"),
      new File(["b"], "b.txt"),
    ]
    const copies = await snapshotDroppedFiles(files)
    expect(copies.map((file) => file.name)).toEqual(["a.txt", "b.txt"])
  })
})
