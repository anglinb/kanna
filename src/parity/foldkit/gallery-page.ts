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

export function galleryPage<Config extends Omit<Parameters<typeof Runtime.makeApplication>[0], "container">>(config: Config): GalleryPage {
  return {
    run(container) {
      Runtime.run(Runtime.makeApplication({ ...config, container } as Parameters<typeof Runtime.makeApplication>[0]))
    },
  }
}
