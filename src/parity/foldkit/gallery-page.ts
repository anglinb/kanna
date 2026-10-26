import { Runtime } from "foldkit"

/**
 * A Foldkit gallery page: a small program showing one component's states,
 * matched against the React page of the same file name. Build one with
 * `galleryPage({ Model, init, update, view })`, with `view` returning a
 * Document like any application.
 */
export interface GalleryPage {
  run(container: HTMLElement): void
}

export function galleryPage<Model, Message extends { _tag: string }, Resources = never>(
  config: Omit<Runtime.ApplicationConfig<Model, Message, Resources>, "container">,
): GalleryPage {
  return {
    run(container) {
      Runtime.run(Runtime.makeApplication<Model, Message, Resources>({ ...config, container } as Runtime.ApplicationConfig<Model, Message, Resources>))
    },
  }
}
