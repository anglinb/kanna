import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { describe, expect, test } from "bun:test"
import { normalizeQuickActions, readProjectQuickActions, writeProjectQuickActions } from "./project-quick-actions"

describe("project quick actions", () => {
  test("normalizes persisted quick actions", () => {
    expect(normalizeQuickActions({
      quickActions: [
        { id: "dev", label: "Dev", command: "bun run dev" },
        { id: "dev", label: "Duplicate", command: "echo duplicate" },
        { id: "empty", label: "Empty", command: " " },
        { id: "test", command: "bun test" },
      ],
    })).toEqual([
      { id: "dev", label: "Dev", command: "bun run dev" },
      { id: "test", label: "bun test", command: "bun test" },
    ])
  })

  test("writes quick actions to the project .kanna directory", async () => {
    const projectPath = await mkdtemp(path.join(tmpdir(), "kanna-project-quick-actions-"))

    const written = await writeProjectQuickActions(projectPath, [
      { id: "dev", label: "Dev", command: "bun run dev" },
    ])

    expect(written).toEqual([
      { id: "dev", label: "Dev", command: "bun run dev" },
    ])
    await expect(readProjectQuickActions(projectPath)).resolves.toEqual(written)
    await expect(Bun.file(path.join(projectPath, ".kanna", "quick-actions.json")).exists()).resolves.toBe(true)
  })

  test("what is saved can always be read back, and what cannot be is not saved", async () => {
    const projectPath = await mkdtemp(path.join(tmpdir(), "kanna-project-quick-actions-"))
    const action = (index: number, command: string) => ({ id: `a${index}`, label: `Action ${index}`, command })

    const kept = [action(1, "bun run dev"), action(2, "bun test")]
    await writeProjectQuickActions(projectPath, kept)

    // Fifty of the longest commands, three bytes a character: more than is read.
    const tooLarge = Array.from({ length: 50 }, (_, index) => action(index, "測".repeat(2_000)))
    await expect(writeProjectQuickActions(projectPath, tooLarge)).rejects.toThrow("too large to save")
    // The refusal left what was there.
    expect(await readProjectQuickActions(projectPath)).toEqual(kept)

    // The largest list that is accepted comes back whole.
    const large = Array.from({ length: 50 }, (_, index) => action(index, "x".repeat(2_000)))
    expect(await writeProjectQuickActions(projectPath, large)).toHaveLength(50)
    expect(await readProjectQuickActions(projectPath)).toEqual(large)
  })

  test("a file too large to read is not replaced by a list that never held it", async () => {
    const projectPath = await mkdtemp(path.join(tmpdir(), "kanna-project-quick-actions-"))
    const filePath = path.join(projectPath, ".kanna", "quick-actions.json")
    await Bun.write(filePath, JSON.stringify({ quickActions: [{ id: "big", label: "big", command: "echo" }], padding: "x".repeat(300 * 1024) }))
    expect(await readProjectQuickActions(projectPath)).toEqual([])
    await expect(writeProjectQuickActions(projectPath, [{ id: "new", label: "new", command: "ls" }])).rejects.toThrow("too large to read")
    expect((await Bun.file(filePath).text()).length).toBeGreaterThan(300 * 1024)
  })
})
