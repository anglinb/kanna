import type { Html, HtmlBuilder } from "foldkit/html"
import { cn } from "../../client/lib/utils"
import type { Child, ExtraAttributes } from "./attributes"

// src/client/components/ui/card.tsx: six styled blocks.

export interface CardOptions<Message> {
  class?: string
  attributes?: ExtraAttributes<Message>
}

type Block = <Message>(options: CardOptions<Message>, children: ReadonlyArray<Child>, h: HtmlBuilder<Message>) => Html

function block(tag: "div" | "h3" | "p", base: string): Block {
  return (options, children, h) => h[tag]([h.Class(cn(base, options.class)), ...(options.attributes ?? [])], children)
}

/** `card({ class: "rounded-xl" }, [cardHeader({}, [cardTitle({}, ["Usage"], h)], h)], h)` */
export const card = block("div", "bg-card text-card-foreground")
export const cardHeader = block("div", "flex flex-col space-y-1.5 p-2")
export const cardTitle = block("h3", "text-2xl font-semibold leading-none tracking-tight")
export const cardDescription = block("p", "text-sm text-muted-foreground")
export const cardContent = block("div", "p-6 pt-0")
export const cardFooter = block("div", "flex items-center p-6 pt-0")
