import type { Attribute, Html, HtmlBuilder } from "foldkit/html"
import type { IconNode } from "lucide"

/**
 * What a lucide-react icon took as props, for the ones the client uses.
 * `attributes` carries anything else (aria-label, style, data-*); an
 * aria-*, role or title among them drops the default aria-hidden, as
 * lucide-react does.
 */
export interface IconOptions<Message> {
  class?: string
  size?: number
  strokeWidth?: number
  color?: string
  /** lucide-react's absoluteStrokeWidth: the stroke stays this many px at any size. */
  absoluteStrokeWidth?: boolean
  attributes?: ReadonlyArray<Attribute<Message>>
  /** Rendered after the paths, as lucide-react renders an icon's children. */
  children?: ReadonlyArray<Html>
}

export type Icon = <Message>(options: IconOptions<Message>, h: HtmlBuilder<Message>) => Html

// lucide-react's mergeClasses: drop empties and repeats, keep order.
function mergeClasses(...classes: (string | undefined)[]) {
  return classes
    .filter((value, index, all): value is string => Boolean(value) && value!.trim() !== "" && all.indexOf(value) === index)
    .join(" ")
    .trim()
}

function toPascalCase(value: string) {
  const camel = value.replace(/^([A-Z])|[\s-_]+(\w)/g, (_match, first: string, next: string) => next ? next.toUpperCase() : first.toLowerCase())
  return camel.charAt(0).toUpperCase() + camel.slice(1)
}

function toKebabCase(value: string) {
  return value.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase()
}

const A11Y_TAGS = new Set(["Role", "Title", "Attribute"])

function hasA11yAttribute<Message>(attributes: ReadonlyArray<Attribute<Message>>) {
  return attributes.some((attribute) => {
    const tag = (attribute as { _tag: string })._tag
    if (tag.startsWith("Aria")) return true
    if (!A11Y_TAGS.has(tag)) return false
    if (tag !== "Attribute") return true
    const key = (attribute as { key: string }).key
    return key.startsWith("aria-") || key === "role" || key === "title"
  })
}

/**
 * The <svg> lucide-react's createLucideIcon renders for icon file `name`:
 * classes `lucide lucide-<kebab> lucide-<name> <class>`, the default stroke
 * attributes, aria-hidden unless labelled, then the icon's paths.
 */
export function defineIcon(name: string, node: IconNode): Icon {
  const iconClass = mergeClasses(`lucide-${toKebabCase(toPascalCase(name))}`, `lucide-${name}`)
  return <Message>(options: IconOptions<Message>, h: HtmlBuilder<Message>) => {
    const size = options.size ?? 24
    const strokeWidth = options.strokeWidth ?? 2
    const attributes = options.attributes ?? []
    const children = options.children ?? []
    return h.svg(
      [
        h.Attribute("xmlns", "http://www.w3.org/2000/svg"),
        h.Attribute("width", String(size)),
        h.Attribute("height", String(size)),
        h.Attribute("viewBox", "0 0 24 24"),
        h.Attribute("fill", "none"),
        h.Attribute("stroke", options.color ?? "currentColor"),
        h.Attribute("stroke-width", String(options.absoluteStrokeWidth ? strokeWidth * 24 / size : strokeWidth)),
        h.Attribute("stroke-linecap", "round"),
        h.Attribute("stroke-linejoin", "round"),
        h.Class(mergeClasses("lucide", iconClass, options.class)),
        ...(children.length === 0 && !hasA11yAttribute(attributes) ? [h.Attribute("aria-hidden", "true")] : []),
        ...attributes,
      ],
      [
        ...node.map(([tag, attrs]) =>
          (h as unknown as Record<string, (attrs: unknown[]) => Html>)[tag]!(
            Object.entries(attrs).map(([key, value]) => h.Attribute(key, String(value))),
          ),
        ),
        ...children,
      ],
    )
  }
}
