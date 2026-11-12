import { useEffect, useRef } from 'react'

interface Props {
  analyser: AnalyserNode | null
  color?: string
  onLevel?: (rms: number) => void
}

export default function Waveform({ analyser, color = '#f5a524', onLevel }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const onLevelRef = useRef(onLevel)
  onLevelRef.current = onLevel

  useEffect(() => {
    const canvas = canvasRef.current!
    const ctx = canvas.getContext('2d')!
    let raf = 0
    let phase = 0
    let last = 0
    // 20fps is plenty for a level meter and a fraction of the battery cost of 60
    const FRAME_MS = 50

    const dpr = window.devicePixelRatio || 1
    const resize = () => {
      canvas.width = canvas.clientWidth * dpr
      canvas.height = canvas.clientHeight * dpr
    }
    resize()

    const data = analyser ? new Float32Array(analyser.fftSize) : null

    const hex = (h: string, a: number) => {
      const n = parseInt(h.slice(1), 16)
      return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`
    }

    const draw = (now: number) => {
      raf = requestAnimationFrame(draw)
      if (now - last < FRAME_MS) return
      last = now
      phase += 0.15
      const { width: w, height: h } = canvas
      const mid = h / 2
      ctx.clearRect(0, 0, w, h)

      if (!analyser || !data) {
        const a = 0.14 + 0.06 * Math.sin(phase)
        ctx.strokeStyle = hex(color, a)
        ctx.lineWidth = 1.5 * dpr
        ctx.beginPath()
        ctx.moveTo(0, mid)
        ctx.lineTo(w, mid)
        ctx.stroke()
        return
      }

      analyser.getFloatTimeDomainData(data)
      let sum = 0
      for (let i = 0; i < data.length; i++) sum += data[i] * data[i]
      const rms = Math.sqrt(sum / data.length)
      onLevelRef.current?.(rms)
      const active = rms > 0.004

      const cols = Math.max(1, Math.floor(w / (2 * dpr)))
      const per = data.length / cols
      const amp = h * 0.44
      const env: number[] = new Array(cols)
      for (let c = 0; c < cols; c++) {
        let peak = 0
        const s = Math.floor(c * per)
        const e = Math.floor((c + 1) * per)
        for (let i = s; i < e; i++) {
          const v = Math.abs(data[i])
          if (v > peak) peak = v
        }
        env[c] = peak
      }

      if (!active) {
        ctx.strokeStyle = hex(color, 0.16)
        ctx.lineWidth = 1.5 * dpr
        ctx.beginPath()
        ctx.moveTo(0, mid)
        ctx.lineTo(w, mid)
        ctx.stroke()
        return
      }

      const grad = ctx.createLinearGradient(0, 0, 0, h)
      grad.addColorStop(0, hex(color, 0.55))
      grad.addColorStop(0.5, hex(color, 0.14))
      grad.addColorStop(1, hex(color, 0.55))

      const x = (c: number) => (c / (cols - 1 || 1)) * w
      ctx.beginPath()
      ctx.moveTo(0, mid)
      for (let c = 0; c < cols; c++) ctx.lineTo(x(c), mid - env[c] * amp)
      for (let c = cols - 1; c >= 0; c--) ctx.lineTo(x(c), mid + env[c] * amp)
      ctx.closePath()
      ctx.fillStyle = grad
      ctx.fill()

      ctx.strokeStyle = hex(color, 0.95)
      ctx.lineWidth = 1.5 * dpr
      ctx.beginPath()
      for (let c = 0; c < cols; c++) {
        const y = mid - env[c] * amp
        c === 0 ? ctx.moveTo(x(c), y) : ctx.lineTo(x(c), y)
      }
      ctx.stroke()
    }

    raf = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(raf)
  }, [analyser, color])

  return <canvas className="wave" ref={canvasRef} />
}
