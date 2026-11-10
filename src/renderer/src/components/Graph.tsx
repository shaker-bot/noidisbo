import { useEffect, useRef } from 'react'
import type { VaultIndex } from '../lib/vault'

interface Node {
  id: string
  name: string
  x: number
  y: number
  vx: number
  vy: number
  degree: number
  pinned: boolean
}

interface Props {
  index: VaultIndex
  active: string | null
  onOpen(path: string): void
}

const radius = (n: Node): number => 4 + Math.sqrt(n.degree) * 1.6

export function Graph({ index, active, onOpen }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const nodes = useRef<Map<string, Node>>(new Map())
  const edges = useRef<[Node, Node][]>([])
  const neighbours = useRef<Map<string, Set<string>>>(new Map())
  const alpha = useRef(1)
  const activeRef = useRef(active)
  const onOpenRef = useRef(onOpen)
  activeRef.current = active
  onOpenRef.current = onOpen

  // Sync the simulation with the vault, keeping positions of notes that already exist.
  useEffect(() => {
    const prev = nodes.current
    const next = new Map<string, Node>()
    const count = index.metas.size
    let i = 0
    for (const meta of index.metas.values()) {
      const old = prev.get(meta.path)
      const angle = (i++ / Math.max(count, 1)) * Math.PI * 2
      const spread = 40 + Math.sqrt(count) * 30
      next.set(
        meta.path,
        old
          ? { ...old, name: meta.name, degree: 0 }
          : {
              id: meta.path,
              name: meta.name,
              x: Math.cos(angle) * spread,
              y: Math.sin(angle) * spread,
              vx: 0,
              vy: 0,
              degree: 0,
              pinned: false
            }
      )
    }
    const list: [Node, Node][] = []
    const near = new Map<string, Set<string>>()
    const seen = new Set<string>()
    for (const [from, outs] of index.outgoing) {
      for (const to of outs) {
        const key = from < to ? `${from}\n${to}` : `${to}\n${from}`
        if (seen.has(key)) continue
        seen.add(key)
        const a = next.get(from)
        const b = next.get(to)
        if (!a || !b) continue
        a.degree++
        b.degree++
        list.push([a, b])
        if (!near.has(from)) near.set(from, new Set())
        if (!near.has(to)) near.set(to, new Set())
        near.get(from)!.add(to)
        near.get(to)!.add(from)
      }
    }
    nodes.current = next
    edges.current = list
    neighbours.current = near
    alpha.current = Math.max(alpha.current, 0.6)
  }, [index])

  useEffect(() => {
    const canvas = canvasRef.current!
    const ctx = canvas.getContext('2d')!
    const view = { x: 0, y: 0, k: 1 }
    let width = 0
    let height = 0
    let hover: Node | null = null
    let drag: { node: Node | null; startX: number; startY: number; moved: boolean } | null = null
    let frame = 0

    const resize = (): void => {
      const dpr = window.devicePixelRatio || 1
      width = canvas.clientWidth
      height = canvas.clientHeight
      canvas.width = Math.round(width * dpr)
      canvas.height = Math.round(height * dpr)
    }
    const observer = new ResizeObserver(resize)
    observer.observe(canvas)
    resize()

    const toWorld = (px: number, py: number): [number, number] => [
      (px - width / 2 - view.x) / view.k,
      (py - height / 2 - view.y) / view.k
    ]
    const hit = (px: number, py: number): Node | null => {
      const [wx, wy] = toWorld(px, py)
      let best: Node | null = null
      let bestD = Infinity
      for (const n of nodes.current.values()) {
        const d = Math.hypot(n.x - wx, n.y - wy)
        if (d < radius(n) + 6 / view.k && d < bestD) {
          best = n
          bestD = d
        }
      }
      return best
    }

    const step = (): void => {
      const a = alpha.current
      if (a < 0.004) return
      const all = [...nodes.current.values()]
      for (let i = 0; i < all.length; i++) {
        const p = all[i]
        for (let j = i + 1; j < all.length; j++) {
          const q = all[j]
          let dx = p.x - q.x
          let dy = p.y - q.y
          let d2 = dx * dx + dy * dy
          if (d2 < 0.01) {
            dx = Math.random() - 0.5
            dy = Math.random() - 0.5
            d2 = 0.25
          }
          const d = Math.sqrt(d2)
          const f = (2200 / d2) * a
          p.vx += (dx / d) * f
          p.vy += (dy / d) * f
          q.vx -= (dx / d) * f
          q.vy -= (dy / d) * f
        }
        p.vx -= p.x * 0.012 * a
        p.vy -= p.y * 0.012 * a
      }
      for (const [p, q] of edges.current) {
        const dx = q.x - p.x
        const dy = q.y - p.y
        const d = Math.hypot(dx, dy) || 1
        const f = (d - 90) * 0.03 * a
        p.vx += (dx / d) * f
        p.vy += (dy / d) * f
        q.vx -= (dx / d) * f
        q.vy -= (dy / d) * f
      }
      for (const n of all) {
        if (n.pinned) {
          n.vx = n.vy = 0
          continue
        }
        n.vx *= 0.82
        n.vy *= 0.82
        n.x += n.vx
        n.y += n.vy
      }
      alpha.current = a * 0.992
    }

    const draw = (): void => {
      const css = getComputedStyle(canvas)
      const ink = css.getPropertyValue('--ink').trim()
      const faint = css.getPropertyValue('--line-strong').trim()
      const muted = css.getPropertyValue('--muted').trim()
      const accent = css.getPropertyValue('--accent').trim()
      const dpr = window.devicePixelRatio || 1
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.clearRect(0, 0, width, height)
      ctx.translate(width / 2 + view.x, height / 2 + view.y)
      ctx.scale(view.k, view.k)

      const focus = hover?.id ?? null
      const near = focus ? neighbours.current.get(focus) : undefined
      const lit = (id: string): boolean => !focus || id === focus || !!near?.has(id)

      ctx.lineWidth = 1 / view.k
      for (const [p, q] of edges.current) {
        const on = focus !== null && (p.id === focus || q.id === focus)
        ctx.strokeStyle = on ? accent : faint
        ctx.globalAlpha = focus && !on ? 0.25 : 1
        ctx.beginPath()
        ctx.moveTo(p.x, p.y)
        ctx.lineTo(q.x, q.y)
        ctx.stroke()
      }
      ctx.font = `${12 / view.k}px -apple-system, "Segoe UI", sans-serif`
      ctx.textAlign = 'center'
      ctx.textBaseline = 'top'
      for (const n of nodes.current.values()) {
        const on = lit(n.id)
        const special = n.id === activeRef.current || n.id === focus
        ctx.globalAlpha = on ? 1 : 0.2
        ctx.fillStyle = special ? accent : n.degree === 0 ? muted : ink
        ctx.beginPath()
        ctx.arc(n.x, n.y, radius(n), 0, Math.PI * 2)
        ctx.fill()
        if (view.k > 0.55 || special || (focus && on)) {
          ctx.fillStyle = special ? accent : muted
          ctx.fillText(n.name, n.x, n.y + radius(n) + 4 / view.k)
        }
      }
      ctx.globalAlpha = 1
    }

    const loop = (): void => {
      step()
      draw()
      frame = requestAnimationFrame(loop)
    }
    frame = requestAnimationFrame(loop)

    const local = (e: MouseEvent): [number, number] => {
      const r = canvas.getBoundingClientRect()
      return [e.clientX - r.left, e.clientY - r.top]
    }
    const onDown = (e: MouseEvent): void => {
      const [px, py] = local(e)
      const node = hit(px, py)
      drag = { node, startX: e.clientX, startY: e.clientY, moved: false }
      if (node) node.pinned = true
    }
    const onMove = (e: MouseEvent): void => {
      const [px, py] = local(e)
      if (!drag) {
        hover = hit(px, py)
        canvas.style.cursor = hover ? 'pointer' : 'grab'
        return
      }
      if (Math.hypot(e.clientX - drag.startX, e.clientY - drag.startY) > 3) drag.moved = true
      if (drag.node) {
        const [wx, wy] = toWorld(px, py)
        drag.node.x = wx
        drag.node.y = wy
        alpha.current = Math.max(alpha.current, 0.3)
      } else {
        view.x += e.movementX
        view.y += e.movementY
      }
    }
    const onUp = (): void => {
      if (!drag) return
      if (drag.node) {
        drag.node.pinned = false
        if (!drag.moved) onOpenRef.current(drag.node.id)
      }
      drag = null
    }
    const onWheel = (e: WheelEvent): void => {
      e.preventDefault()
      const [px, py] = local(e)
      const [wx, wy] = toWorld(px, py)
      view.k = Math.min(4, Math.max(0.2, view.k * Math.exp(-e.deltaY * 0.0015)))
      view.x = px - width / 2 - wx * view.k
      view.y = py - height / 2 - wy * view.k
    }
    canvas.addEventListener('mousedown', onDown)
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    canvas.addEventListener('wheel', onWheel, { passive: false })
    return () => {
      cancelAnimationFrame(frame)
      observer.disconnect()
      canvas.removeEventListener('mousedown', onDown)
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      canvas.removeEventListener('wheel', onWheel)
    }
  }, [])

  return <canvas className="graph" ref={canvasRef} aria-label="Graph of notes and the links between them" />
}
