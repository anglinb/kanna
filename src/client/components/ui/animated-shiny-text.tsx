import type { ComponentPropsWithoutRef, CSSProperties } from "react"
import { cn } from "../../lib/utils"

export interface AnimatedShinyTextProps extends ComponentPropsWithoutRef<"span"> {
  shimmerWidth?: number
  animate?: boolean
}

export function AnimatedShinyText({
  children,
  className,
  shimmerWidth = 100,
  animate = true,
  style,
  ...props
}: AnimatedShinyTextProps) {
  const halfShimmerWidth = Math.min(Math.max(shimmerWidth, 0), 100) / 2

  return (
    <span
      className={cn(
        // The base text must truncate like the animated copy below, or long
        // labels hard-clip at the overflow edge with no ellipsis. `align-top`
        // matters too: `overflow-hidden` moves an inline-block's baseline to
        // its bottom edge, which grows the line box past the font's 20px.
        "kanna-shiny-text relative mx-auto inline-block max-w-md overflow-hidden text-ellipsis whitespace-nowrap align-top text-foreground/50",
        !animate && "text-neutral",
        className
      )}
      style={{
        ...style,
        "--shiny-half-width": `${halfShimmerWidth}px`,
      } as CSSProperties}
      {...props}
    >
      {children}
      {animate ? (
        <span aria-hidden className="kanna-shiny-track pointer-events-none absolute inset-0 block">
          <span className="kanna-shiny-copy block h-full w-full overflow-hidden text-ellipsis whitespace-nowrap text-black/80 dark:text-white/80">
            {children}
          </span>
        </span>
      ) : null}
    </span>
  )
}
