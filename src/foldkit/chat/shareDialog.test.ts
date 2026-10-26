import { describe, expect, test } from "bun:test"
import type { HtmlBuilder } from "foldkit/html"
import { Option } from "effect"
import { Scene, Story } from "foldkit/test"
import * as CopyButton from "../ui/copy-button"
import * as Dialog from "../ui/dialog"
import * as ShareDialog from "./shareDialog"

const URL = "https://kanna.sh/s/abc"
const open = ShareDialog.sync(ShareDialog.init(), URL).model

const dialogView = Scene.withViewInputs(ShareDialog.view, { shareUrl: URL })
// The dialog renders nothing while closed; Scene wants an element.
const sceneView = (model: ShareDialog.Model, h: HtmlBuilder<ShareDialog.Message>) => h.main([], [dialogView()(model, h)])

describe("ShareDialog", () => {
  test("follows the root's link: open while there is one, closed after", () => {
    expect(open.dialog.phase).toBe("Open")
    expect(open.shownUrl).toBe(URL)
    const closing = ShareDialog.sync(open, null)
    expect(closing.model.dialog.phase).toBe("Closing")
    // The link stays through the exit animation.
    expect(closing.model.shownUrl).toBe(URL)
  })

  test("a dismissal tells the root it closed", () => {
    Story.story(
      ShareDialog.update,
      Story.given(open),
      Story.message(ShareDialog.Message.GotDialogMessage({ message: Dialog.Message.DismissedContent() })),
      Story.expectOutMessage(ShareDialog.OutMessage.Closed()),
      Story.Command.resolve(Dialog.WaitForExitAnimation, Dialog.Message.CompletedExitAnimation({ version: 2 })),
      Story.model((model) => expect(model.dialog.phase).toBe("Closed")),
    )
  })

  test("the copy button copies the link and only then shows its check; a failure goes up", () => {
    const requested = ShareDialog.update(open, ShareDialog.Message.GotCopyMessage({ message: CopyButton.Message.ClickedCopy({ text: Option.none() }) }))
    expect(requested.commands?.map((command) => command.name)).toEqual(["CopyStandaloneShareLink"])
    expect(requested.model.copy.isCopied).toBe(false)
    const copied = ShareDialog.update(open, ShareDialog.Message.SucceededCopyLink())
    expect(copied.model.copy.isCopied).toBe(true)
    const failed = ShareDialog.update(open, ShareDialog.Message.FailedCopyLink({ error: "Clipboard is not available" }))
    expect(failed.outMessage).toEqual(ShareDialog.OutMessage.FailedCopy({ error: "Clipboard is not available" }))
  })

  test("Scene: the link, its copy button, and Open", () => {
    Scene.scene(
      { update: ShareDialog.update, view: sceneView },
      Scene.given(open),
      Scene.expect(Scene.role("dialog")).toHaveAccessibleName("Shared Link"),
      Scene.expect(Scene.text(URL)).toExist(),
      Scene.expect(Scene.role("button", { name: "Copy link" })).toExist(),
      Scene.Mount.resolve(Dialog.DialogContent, Dialog.Message.CompletedMountContent()),
      Scene.click(Scene.role("button", { name: "Open" })),
      Scene.expectOutMessage(ShareDialog.OutMessage.OpenedLink()),
    )
  })
})
