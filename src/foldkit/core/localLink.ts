/** A local file link the user opened (a click or a right-click), with where in the file and where on screen. */
export type OpenLocalLinkTarget = {
  path: string
  line?: number
  column?: number
  clientX?: number
  clientY?: number
  trigger?: "click" | "contextmenu"
}
