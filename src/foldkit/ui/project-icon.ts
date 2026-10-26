import type { Html, HtmlBuilder } from "foldkit/html"
import { getProjectColor, getProjectInitials } from "../../client/lib/project-monogram"
import { cn } from "../../client/lib/utils"

export interface ProjectIconOptions<Message> {
  name: string
  iconUrl?: string
  class?: string
  /**
   * Icon URLs that failed to load. The React component kept the failed URL in
   * its own state; here the caller keeps it (one set for the whole page is
   * enough: a URL that failed once fails everywhere) and reports new failures
   * through `onIconError`.
   */
  failedIconUrls?: ReadonlyArray<string>
  onIconError?: (iconUrl: string) => Message
}

/**
 * A project's mark at 16px: its own icon when the server found one
 * (`iconUrl`), and otherwise its initials on a colour taken from its name.
 *
 *   projectIcon({ name: group.title, iconUrl: group.iconUrl, failedIconUrls: model.failedIconUrls, onIconError: (url) => FailedLoadProjectIcon({ url }) }, h)
 */
export function projectIcon<Message>(options: ProjectIconOptions<Message>, h: HtmlBuilder<Message>): Html {
  const { iconUrl, onIconError } = options
  // The URL that failed, not a flag: a changed icon is a new URL and gets its own try.
  if (iconUrl && !options.failedIconUrls?.includes(iconUrl)) {
    return h.img([
      h.Src(iconUrl),
      h.Alt(""),
      h.Draggable(false),
      h.Decoding("async"),
      ...(onIconError ? [h.OnError(onIconError(iconUrl))] : []),
      h.Class(cn("size-4 shrink-0 rounded-[4px] object-contain", options.class)),
    ])
  }

  const initials = getProjectInitials(options.name)
  return h.span(
    [
      h.AriaHidden(true),
      h.Style({ "background-color": getProjectColor(options.name) }),
      h.Class(cn(
        // Its own weight and tracking: the row around it goes bold when unread.
        "flex size-4 shrink-0 select-none items-center justify-center rounded-[4px] font-bold leading-none tracking-tighter text-white",
        initials.length > 1 ? "text-[8px]" : "text-[10px]",
        options.class,
      )),
    ],
    [initials],
  )
}
