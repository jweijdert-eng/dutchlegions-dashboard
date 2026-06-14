import { useEffect, useRef } from 'react'

interface Star {
  x: number      // 0..1 (fractie van breedte)
  y: number      // 0..1 (fractie van hoogte)
  r: number      // straal in px
  base: number   // basishelderheid 0..1
  tw: number     // twinkel-snelheid
  ph: number     // twinkel-fase
}

/**
 * Lichtgewicht geanimeerd sterrenveld op een <canvas>. Vult de ouder (position
 * relative). Sterren twinkelen en driften langzaam horizontaal voor diepte.
 * Pauzeert automatisch buiten beeld en respecteert prefers-reduced-motion.
 */
export default function Starfield({
  density = 0.00018,         // sterren per px²
  color = '#9fdcff',
  drift = 6,                 // px/s horizontale drift
  className,
  style,
}: {
  density?: number
  color?: string
  drift?: number
  className?: string
  style?: React.CSSProperties
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    let stars: Star[] = []
    let w = 0, h = 0, dpr = Math.min(window.devicePixelRatio || 1, 2)
    let raf = 0
    let visible = true
    let last = performance.now()
    let offset = 0

    function resize() {
      const parent = canvas!.parentElement
      if (!parent) return
      w = parent.clientWidth
      h = parent.clientHeight
      dpr = Math.min(window.devicePixelRatio || 1, 2)
      canvas!.width = Math.max(1, Math.floor(w * dpr))
      canvas!.height = Math.max(1, Math.floor(h * dpr))
      canvas!.style.width = w + 'px'
      canvas!.style.height = h + 'px'
      ctx!.setTransform(dpr, 0, 0, dpr, 0, 0)
      const count = Math.round(w * h * density)
      stars = Array.from({ length: count }, () => ({
        x: Math.random(),
        y: Math.random(),
        r: Math.random() < 0.85 ? Math.random() * 0.9 + 0.3 : Math.random() * 1.6 + 1,
        base: Math.random() * 0.5 + 0.3,
        tw: Math.random() * 1.6 + 0.4,
        ph: Math.random() * Math.PI * 2,
      }))
    }

    function draw(now: number) {
      const dt = Math.min(0.05, (now - last) / 1000)
      last = now
      if (!reduced) offset = (offset + drift * dt) % w
      ctx!.clearRect(0, 0, w, h)
      const t = now / 1000
      for (const s of stars) {
        const px = ((s.x * w + offset) % w + w) % w
        const py = s.y * h
        const a = reduced ? s.base : s.base * (0.55 + 0.45 * Math.sin(t * s.tw + s.ph))
        ctx!.globalAlpha = Math.max(0, Math.min(1, a))
        ctx!.beginPath()
        ctx!.arc(px, py, s.r, 0, Math.PI * 2)
        ctx!.fillStyle = color
        ctx!.fill()
        if (s.r > 1.3) {
          ctx!.globalAlpha = a * 0.25
          ctx!.beginPath()
          ctx!.arc(px, py, s.r * 2.6, 0, Math.PI * 2)
          ctx!.fill()
        }
      }
      ctx!.globalAlpha = 1
      raf = visible ? requestAnimationFrame(draw) : 0
    }

    resize()
    const ro = new ResizeObserver(resize)
    if (canvas.parentElement) ro.observe(canvas.parentElement)

    const io = new IntersectionObserver(([e]) => {
      visible = e.isIntersecting
      if (visible && !raf) { last = performance.now(); raf = requestAnimationFrame(draw) }
      else if (!visible && raf) { cancelAnimationFrame(raf); raf = 0 }
    }, { threshold: 0 })
    io.observe(canvas)

    last = performance.now()
    raf = requestAnimationFrame(draw)

    return () => {
      if (raf) cancelAnimationFrame(raf)
      ro.disconnect()
      io.disconnect()
    }
  }, [density, color, drift])

  return (
    <canvas
      ref={canvasRef}
      aria-hidden
      className={className}
      style={{ position: 'absolute', inset: 0, pointerEvents: 'none', ...style }}
    />
  )
}
