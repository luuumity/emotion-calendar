import { useEffect, useRef } from 'react'
import Matter from 'matter-js'
import { isDark, scoreRGB } from '../lib/colors'

export type GachaBall = { id: number; score: number; index: number }

type BallMeta = GachaBall
type MetaBody = Matter.Body & { meta: BallMeta }

const W = 460
const H = 680
const DOME = { x: 24, y: 24, w: 412, h: 560, r: 64 }
const RADIUS = 25

function domePath(ctx: CanvasRenderingContext2D) {
  const { x, y, w, h, r } = DOME
  ctx.beginPath()
  ctx.moveTo(x + r, y)
  ctx.lineTo(x + w - r, y)
  ctx.quadraticCurveTo(x + w, y, x + w, y + r)
  ctx.lineTo(x + w, y + h - r)
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h)
  ctx.lineTo(x + r, y + h)
  ctx.quadraticCurveTo(x, y + h, x, y + h - r)
  ctx.lineTo(x, y + r)
  ctx.quadraticCurveTo(x, y, x + r, y)
  ctx.closePath()
}

function drawBall(ctx: CanvasRenderingContext2D, body: MetaBody, selected: boolean) {
  const { x, y } = body.position
  const [r, g, b] = scoreRGB(body.meta.score)
  const dark = isDark(body.meta.score)

  ctx.save()
  ctx.translate(x, y)

  if (selected) {
    ctx.beginPath()
    ctx.arc(0, 0, RADIUS + 7, 0, Math.PI * 2)
    ctx.strokeStyle = 'rgba(47, 42, 37, 0.65)'
    ctx.lineWidth = 2
    ctx.setLineDash([5, 5])
    ctx.stroke()
    ctx.setLineDash([])
  }

  ctx.save()
  ctx.beginPath()
  ctx.arc(0, 0, RADIUS, 0, Math.PI * 2)
  ctx.closePath()
  ctx.clip()

  const shade = (value: number, t: number) => Math.round(value + (255 - value) * t)
  const gradient = ctx.createRadialGradient(-RADIUS * 0.38, -RADIUS * 0.42, RADIUS * 0.1, 0, 0, RADIUS * 1.15)
  gradient.addColorStop(0, `rgb(${shade(r, 0.5)}, ${shade(g, 0.5)}, ${shade(b, 0.5)})`)
  gradient.addColorStop(0.62, `rgb(${r}, ${g}, ${b})`)
  gradient.addColorStop(1, `rgb(${Math.round(r * 0.82)}, ${Math.round(g * 0.82)}, ${Math.round(b * 0.82)})`)
  ctx.fillStyle = gradient
  ctx.fillRect(-RADIUS, -RADIUS, RADIUS * 2, RADIUS * 2)

  ctx.rotate(body.angle)
  ctx.fillStyle = 'rgba(255, 255, 255, 0.22)'
  ctx.fillRect(-RADIUS, -2, RADIUS * 2, 4)
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.55)'
  ctx.lineWidth = 1.2
  ctx.beginPath()
  ctx.moveTo(-RADIUS, -4)
  ctx.lineTo(RADIUS, -4)
  ctx.stroke()
  ctx.rotate(-body.angle)

  ctx.beginPath()
  ctx.ellipse(-RADIUS * 0.34, -RADIUS * 0.42, RADIUS * 0.34, RADIUS * 0.2, -0.6, 0, Math.PI * 2)
  ctx.fillStyle = 'rgba(255, 255, 255, 0.5)'
  ctx.fill()
  ctx.restore()

  ctx.beginPath()
  ctx.arc(0, 0, RADIUS, 0, Math.PI * 2)
  ctx.strokeStyle = 'rgba(47, 42, 37, 0.18)'
  ctx.lineWidth = 1.5
  ctx.stroke()

  ctx.fillStyle = dark ? '#fffaf2' : '#2f2a25'
  ctx.font = '700 18px ui-sans-serif, system-ui, -apple-system, "PingFang SC", sans-serif'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText(String(body.meta.index), 0, 1)

  ctx.restore()
}

export function GachaMachine({
  stageKey,
  balls,
  selectedId,
  onSelect
}: {
  stageKey: string
  balls: GachaBall[]
  selectedId: number | null
  onSelect: (id: number | null) => void
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const engineRef = useRef<Matter.Engine | null>(null)
  const ballMapRef = useRef<Map<number, MetaBody>>(new Map())
  const selectedRef = useRef(selectedId)
  const selectRef = useRef(onSelect)
  const countRef = useRef(0)

  selectedRef.current = selectedId
  selectRef.current = onSelect
  countRef.current = balls.length

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const dpr = Math.min(2, window.devicePixelRatio || 1)
    canvas.width = W * dpr
    canvas.height = H * dpr

    const engine = Matter.Engine.create({ enableSleeping: true })
    engine.gravity.y = 1
    engineRef.current = engine
    ballMapRef.current = new Map()
    const wallStyle = { isStatic: true, restitution: 0.2, friction: 0.1 }
    Matter.Composite.add(engine.world, [
      Matter.Bodies.rectangle(4, 300, 60, 900, wallStyle),
      Matter.Bodies.rectangle(456, 300, 60, 900, wallStyle),
      Matter.Bodies.rectangle(230, 596, 500, 60, wallStyle),
      Matter.Bodies.rectangle(230, 10, 500, 60, wallStyle)
    ])

    const findBall = (clientX: number, clientY: number) => {
      const rect = canvas.getBoundingClientRect()
      const x = ((clientX - rect.left) / rect.width) * W
      const y = ((clientY - rect.top) / rect.height) * H
      let found: MetaBody | null = null
      let best = RADIUS + 8
      for (const body of ballMapRef.current.values()) {
        const dist = Math.hypot(body.position.x - x, body.position.y - y)
        if (dist < best) {
          best = dist
          found = body
        }
      }
      return found
    }

    const handleDown = (event: PointerEvent) => {
      const ball = findBall(event.clientX, event.clientY)
      if (!ball) {
        selectRef.current(null)
        return
      }
      Matter.Body.setAngularVelocity(ball, (Math.random() - 0.5) * 0.15)
      Matter.Sleeping.set(ball, false)
      Matter.Body.setVelocity(ball, { x: ball.velocity.x, y: -2.2 })
      selectRef.current(ball.meta.id === selectedRef.current ? null : ball.meta.id)
    }

    const handleMove = (event: PointerEvent) => {
      canvas.style.cursor = findBall(event.clientX, event.clientY) ? 'pointer' : 'default'
    }

    canvas.addEventListener('pointerdown', handleDown)
    canvas.addEventListener('pointermove', handleMove)

    let raf = 0
    const draw = () => {
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.clearRect(0, 0, W, H)

      // 机器底座
      ctx.save()
      ctx.fillStyle = '#f2705f'
      ctx.beginPath()
      ctx.roundRect(12, 552, 436, 112, 30)
      ctx.fill()
      ctx.strokeStyle = '#2f2a25'
      ctx.lineWidth = 4
      ctx.stroke()
      ctx.fillStyle = 'rgba(47, 42, 37, 0.82)'
      ctx.beginPath()
      ctx.roundRect(132, 596, 196, 34, 17)
      ctx.fill()
      ctx.fillStyle = 'rgba(255, 255, 255, 0.28)'
      ctx.beginPath()
      ctx.roundRect(142, 602, 176, 8, 4)
      ctx.fill()
      ctx.beginPath()
      ctx.arc(388, 612, 24, 0, Math.PI * 2)
      ctx.fillStyle = '#fff6ea'
      ctx.fill()
      ctx.strokeStyle = '#2f2a25'
      ctx.lineWidth = 3.5
      ctx.stroke()
      ctx.beginPath()
      ctx.moveTo(388, 600)
      ctx.lineTo(388, 624)
      ctx.stroke()
      ctx.fillStyle = 'rgba(255, 250, 242, 0.9)'
      ctx.font = '700 10px ui-sans-serif, system-ui, sans-serif'
      ctx.textAlign = 'left'
      ctx.textBaseline = 'middle'
      ctx.fillText('E M O T I O N   C A P S U L E', 30, 580)
      ctx.restore()

      // 玻璃罩
      ctx.save()
      domePath(ctx)
      const glass = ctx.createLinearGradient(0, DOME.y, 0, DOME.y + DOME.h)
      glass.addColorStop(0, 'rgba(255, 255, 255, 0.92)')
      glass.addColorStop(0.55, 'rgba(249, 244, 235, 0.72)')
      glass.addColorStop(1, 'rgba(240, 232, 219, 0.9)')
      ctx.fillStyle = glass
      ctx.fill()
      ctx.clip()

      const inner = ctx.createRadialGradient(W / 2, DOME.y + 240, 40, W / 2, DOME.y + 240, 340)
      inner.addColorStop(0, 'rgba(255, 255, 255, 0.35)')
      inner.addColorStop(1, 'rgba(120, 100, 80, 0.08)')
      ctx.fillStyle = inner
      ctx.fillRect(0, 0, W, H)

      for (const body of ballMapRef.current.values()) {
        drawBall(ctx, body, body.meta.id === selectedRef.current)
      }

      if (countRef.current === 0) {
        ctx.fillStyle = 'rgba(47, 42, 37, 0.42)'
        ctx.textAlign = 'center'
        ctx.textBaseline = 'middle'
        ctx.font = '600 20px ui-sans-serif, system-ui, "PingFang SC", sans-serif'
        ctx.fillText('还没有扭蛋', W / 2, 280)
        ctx.font = '400 14px ui-sans-serif, system-ui, "PingFang SC", sans-serif'
        ctx.fillText('拖动色块投进来试试', W / 2, 310)
      }
      ctx.restore()

      // 高光与玻璃边框
      ctx.save()
      ctx.globalAlpha = 0.45
      ctx.strokeStyle = '#ffffff'
      ctx.lineWidth = 7
      ctx.lineCap = 'round'
      ctx.beginPath()
      ctx.moveTo(66, 140)
      ctx.quadraticCurveTo(56, 300, 76, 470)
      ctx.stroke()
      ctx.globalAlpha = 0.22
      ctx.lineWidth = 14
      ctx.beginPath()
      ctx.moveTo(404, 170)
      ctx.quadraticCurveTo(416, 320, 400, 460)
      ctx.stroke()
      ctx.restore()

      ctx.save()
      domePath(ctx)
      ctx.strokeStyle = '#2f2a25'
      ctx.lineWidth = 5
      ctx.stroke()
      ctx.restore()

      // 顶部旋钮
      ctx.save()
      ctx.beginPath()
      ctx.roundRect(W / 2 - 20, 2, 40, 22, 9)
      ctx.fillStyle = '#fff6ea'
      ctx.fill()
      ctx.strokeStyle = '#2f2a25'
      ctx.lineWidth = 4
      ctx.stroke()
      ctx.restore()
    }

    const tick = () => {
      Matter.Engine.update(engine, 1000 / 60)
      draw()
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)

    return () => {
      cancelAnimationFrame(raf)
      canvas.removeEventListener('pointerdown', handleDown)
      canvas.removeEventListener('pointermove', handleMove)
      Matter.Composite.clear(engine.world, false)
      Matter.Engine.clear(engine)
      engineRef.current = null
      ballMapRef.current.clear()
    }
  }, [stageKey])

  useEffect(() => {
    const engine = engineRef.current
    if (!engine) return
    const map = ballMapRef.current

    const present = new Set(balls.map((b) => b.id))
    for (const [id, body] of Array.from(map.entries())) {
      if (!present.has(id)) {
        Matter.Composite.remove(engine.world, body)
        map.delete(id)
      }
    }

    for (const ball of balls) {
      const existing = map.get(ball.id)
      if (existing) {
        if (existing.meta.score !== ball.score || existing.meta.index !== ball.index) {
          existing.meta.score = ball.score
          existing.meta.index = ball.index
          Matter.Sleeping.set(existing, false)
          Matter.Body.setVelocity(existing, { x: (Math.random() - 0.5) * 1.2, y: -1.6 })
        }
        continue
      }

      const x = 66 + ((ball.id * 53) % 328) + (Math.random() - 0.5) * 14
      const body = Matter.Bodies.circle(x, 72, RADIUS, {
        restitution: 0.32,
        friction: 0.04,
        frictionAir: 0.014,
        density: 0.0012,
        sleepThreshold: 80
      }) as MetaBody
      body.meta = { id: ball.id, score: ball.score, index: ball.index }
      Matter.Body.setAngularVelocity(body, (Math.random() - 0.5) * 0.08)
      Matter.Composite.add(engine.world, body)
      map.set(ball.id, body)
    }
  }, [balls, stageKey])

  return (
    <div className="gacha-stage">
      <canvas ref={canvasRef} className="gacha-canvas" aria-label="情绪扭蛋机" role="img" />
    </div>
  )
}
