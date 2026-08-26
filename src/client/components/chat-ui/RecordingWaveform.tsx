import { useEffect, useRef } from "react"

/**
 * Auto-scrolling live volume bars shown in place of the textarea while
 * recording. A direct port of the iOS RecordingLevelsView: 3px rounded
 * bars with 2px gaps, newest sample at the right edge, centered on the
 * midline.
 */
const WAVE_BAR_WIDTH = 3
const WAVE_BAR_SPACING = 2
const WAVE_MIN_BAR_HEIGHT = 3

export function RecordingWaveform({ levels }: { levels: number[] }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const dpr = window.devicePixelRatio || 1
    const { width, height } = canvas.getBoundingClientRect()
    if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(height * dpr)) {
      canvas.width = Math.round(width * dpr)
      canvas.height = Math.round(height * dpr)
    }
    const ctx = canvas.getContext("2d")
    if (!ctx) return
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, width, height)
    ctx.fillStyle = window.getComputedStyle(canvas).color

    const step = WAVE_BAR_WIDTH + WAVE_BAR_SPACING
    const capacity = Math.max(1, Math.floor(width / step))
    const visible = levels.slice(-capacity)
    const midY = height / 2

    let x = width - WAVE_BAR_WIDTH
    for (let i = visible.length - 1; i >= 0; i--) {
      const barHeight = Math.max(WAVE_MIN_BAR_HEIGHT, visible[i] * height)
      ctx.beginPath()
      ctx.roundRect(x, midY - barHeight / 2, WAVE_BAR_WIDTH, barHeight, WAVE_BAR_WIDTH / 2)
      ctx.fill()
      x -= step
    }
  }, [levels])

  return <canvas ref={canvasRef} className="h-9 w-full text-muted-foreground" role="img" aria-label="Recording" />
}
