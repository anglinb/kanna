import type { Attribute, ChildAttribute, Html } from "foldkit/html"

/**
 * What a primitive's caller can add to the element it renders: any attribute
 * or handler, including a Submodel's bundle (a tooltip trigger's, a popover's).
 * The React primitives took `...props`; this is that.
 *
 * Put classes in the primitive's `class` option, not here: the primitive
 * merges them with its own through `cn`, as the React component did.
 */
export type ExtraAttributes<Message> = ReadonlyArray<Attribute<Message> | ChildAttribute>

/** A child of an element: markup or text (foldkit's `Child`, which its public API doesn't export). */
export type Child = Html | string
