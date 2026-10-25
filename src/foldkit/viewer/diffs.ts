import { File as CodeFile, FileDiff, getSingularPatch, DIFFS_TAG_NAME, type FileDiffOptions, type FileOptions } from "@pierre/diffs"
import { Schema } from "effect"
import { Mount } from "foldkit"
import { domStream } from "../ui/overlay/stream"
import { Message } from "./message"

// @pierre/diffs is a plain DOM library: React's <PatchDiff> and <File> made
// its `diffs-container` element and handed it to the renderer from a ref.
// These Mounts do the same on the element React wrapped it in. The
// renderer's options are captured at mount: a change of options (unified or
// side by side, wrapping, the theme) is a new key on the host, and a new
// renderer, where React re-rendered the one it had with the new options.

/** How long to wait for the highlighted file to draw the line before giving up on the jump. */
const LINE_JUMP_TIMEOUT_MS = 3_000

/** One file's patch (DiffPatchView's `<PatchDiff>`), drawn into its own shadow root. */
export const PatchDiffMount = Mount.defineStream("ViewerPatchDiff", {
  args: { patch: Schema.String, diffStyle: Schema.String, wrap: Schema.Boolean, theme: Schema.String },
  messages: [Message.CompletedSideEffect],
  execute: ({ element, patch, diffStyle, wrap, theme }) =>
    domStream<typeof Message.CompletedSideEffect.Type>(() => {
      const container = document.createElement(DIFFS_TAG_NAME)
      element.appendChild(container)
      const options: FileDiffOptions<undefined> = {
        diffStyle: diffStyle as "unified" | "split",
        disableFileHeader: true,
        disableBackground: false,
        overflow: wrap ? "wrap" : "scroll",
        lineDiffType: "word",
        diffIndicators: "classic",
        themeType: theme as "light" | "dark",
      }
      const instance = new FileDiff(options, undefined, true)
      instance.hydrate({ fileDiff: getSingularPatch(patch), fileContainer: container })
      return () => {
        instance.cleanUp()
        container.remove()
      }
    }),
})

/**
 * A whole file, highlighted (FileViewer's CodeView `<File>`), with the linked
 * line marked and scrolled to the middle of the view. The renderer draws into
 * its own shadow root, a frame or more after mounting, so the jump waits for
 * the line to exist.
 */
export const CodeFileMount = Mount.defineStream("ViewerCodeFile", {
  args: { name: Schema.String, contents: Schema.String, line: Schema.NullOr(Schema.Number), wrap: Schema.Boolean, theme: Schema.String },
  messages: [Message.CompletedSideEffect],
  execute: ({ element, name, contents, line, wrap, theme }) =>
    domStream<typeof Message.CompletedSideEffect.Type>(() => {
      const container = document.createElement(DIFFS_TAG_NAME)
      element.appendChild(container)
      const options: FileOptions<undefined> = {
        disableFileHeader: true,
        overflow: wrap ? "wrap" : "scroll",
        themeType: theme as "light" | "dark",
      }
      const instance = new CodeFile(options, undefined, true)
      instance.hydrate({ file: { name, contents }, fileContainer: container })
      instance.setSelectedLines(line === null ? null : { start: line, end: line })

      let frame = 0
      if (line !== null) {
        const started = performance.now()
        const find = () => {
          for (const host of element.querySelectorAll("*")) {
            const target = host.shadowRoot?.querySelector(`[data-line="${line}"]`)
            if (target) {
              target.scrollIntoView({ block: "center" })
              return
            }
          }
          if (performance.now() - started < LINE_JUMP_TIMEOUT_MS) frame = requestAnimationFrame(find)
        }
        frame = requestAnimationFrame(find)
      }
      return () => {
        cancelAnimationFrame(frame)
        instance.cleanUp()
        container.remove()
      }
    }),
})
