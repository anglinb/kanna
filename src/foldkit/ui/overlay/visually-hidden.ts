/**
 * Radix's VisuallyHidden style (@radix-ui/react-visually-hidden), as React
 * serialises it: the tooltip's role="tooltip" copy and the select's hidden
 * native <select> use it.
 */
export const VISUALLY_HIDDEN_STYLE: Record<string, string> = {
  position: "absolute",
  border: "0px",
  width: "1px",
  height: "1px",
  padding: "0px",
  margin: "-1px",
  overflow: "hidden",
  clip: "rect(0px, 0px, 0px, 0px)",
  "white-space": "nowrap",
  "word-wrap": "normal",
}
