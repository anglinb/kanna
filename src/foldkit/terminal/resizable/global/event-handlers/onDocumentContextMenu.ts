import { completeActivePointerResize } from "../utils/completeActivePointerResize";

export function onDocumentContextMenu(event: MouseEvent) {
  if (event.defaultPrevented) {
    return;
  }

  completeActivePointerResize(event.currentTarget as Document);
}
