import { useEffect, useMemo, useRef, useState } from 'react'
import {
  CategoryScale,
  Chart as ChartJS,
  Filler,
  LineElement,
  LinearScale,
  PointElement,
  Tooltip,
  type ChartOptions,
} from 'chart.js'
import { Line } from 'react-chartjs-2'

/**
 * Chart.js is registered tree-shakably: only the scales, elements and plugins
 * this chart actually uses are pulled in. Registering everything would roughly
 * double the charting chunk for features that are never rendered.
 */
ChartJS.register(CategoryScale, LinearScale, PointElement, LineElement, Filler, Tooltip)

export interface ActivitySample {
  readonly cpu: number | null
  readonly memory: number
}

export interface ActivityChartProps {
  samples: readonly ActivitySample[]
  cpuLabel: string
  memoryLabel: string
}

/**
 * Rolling processor and memory utilisation.
 *
 * Animation is disabled outright. The series updates every two seconds, and an
 * animated transition between frames makes a live chart appear to lag behind the
 * numbers displayed beside it.
 */
export function ActivityChart({ samples, cpuLabel, memoryLabel }: ActivityChartProps) {
  const palette = useThemePalette()

  const data = useMemo(
    () => ({
      labels: samples.map((_, index) => String(index)),
      datasets: [
        {
          label: cpuLabel,
          data: samples.map((sample) => sample.cpu),
          borderColor: palette.accent,
          backgroundColor: palette.accentFill,
          borderWidth: 2,
          fill: true,
          tension: 0.35,
          pointRadius: 0,
          // Keeps the line continuous across the first sample, where CPU
          // utilisation is not yet computable.
          spanGaps: true,
        },
        {
          label: memoryLabel,
          data: samples.map((sample) => sample.memory),
          borderColor: palette.info,
          backgroundColor: 'transparent',
          borderWidth: 2,
          borderDash: [4, 4],
          fill: false,
          tension: 0.35,
          pointRadius: 0,
        },
      ],
    }),
    [samples, cpuLabel, memoryLabel, palette],
  )

  const options = useMemo<ChartOptions<'line'>>(
    () => ({
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: palette.surface,
          titleColor: palette.ink,
          bodyColor: palette.inkMuted,
          borderColor: palette.line,
          borderWidth: 1,
          padding: 10,
          displayColors: true,
          callbacks: {
            title: () => '',
            label: (item) =>
              `${item.dataset.label ?? ''}: ${item.parsed.y === null ? '—' : `${Math.round(item.parsed.y)}%`}`,
          },
        },
      },
      scales: {
        x: { display: false },
        y: {
          min: 0,
          max: 100,
          ticks: {
            stepSize: 25,
            color: palette.inkSubtle,
            font: { size: 10 },
            callback: (value) => `${String(value)}%`,
          },
          grid: { color: palette.line },
          border: { display: false },
        },
      },
    }),
    [palette],
  )

  return (
    <div className="h-44">
      <Line data={data} options={options} aria-label={`${cpuLabel}, ${memoryLabel}`} />
    </div>
  )
}

interface ThemePalette {
  accent: string
  accentFill: string
  info: string
  surface: string
  line: string
  ink: string
  inkMuted: string
  inkSubtle: string
}

/**
 * Resolve design tokens into concrete colours for Chart.js.
 *
 * Chart.js paints to a canvas, so it cannot consume CSS variables — the values
 * have to be read out of the cascade. A MutationObserver on the root's `class`
 * and `data-accent` attributes recomputes them when the theme or accent changes,
 * which is what keeps the chart in step with the rest of the interface.
 */
function useThemePalette(): ThemePalette {
  const [palette, setPalette] = useState<ThemePalette>(readPalette)
  const frameRef = useRef<number | null>(null)

  useEffect(() => {
    const observer = new MutationObserver(() => {
      // Read on the next frame: the class has changed, but the browser has not
      // necessarily recomputed the custom properties that depend on it yet.
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current)
      frameRef.current = requestAnimationFrame(() => {
        setPalette(readPalette())
      })
    })

    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['class', 'data-accent'],
    })

    return () => {
      observer.disconnect()
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current)
    }
  }, [])

  return palette
}

function readPalette(): ThemePalette {
  const styles = getComputedStyle(document.documentElement)
  const read = (name: string, fallback: string): string => {
    const value = styles.getPropertyValue(name).trim()
    return value.length > 0 ? value : fallback
  }

  const accent = read('--rx-accent', '#3b82f6')

  return {
    accent,
    // `color-mix` keeps the fill tied to whichever accent is active instead of
    // hard-coding a translucent variant per palette.
    accentFill: `color-mix(in oklch, ${accent} 16%, transparent)`,
    info: read('--rx-info', '#0ea5e9'),
    surface: read('--rx-surface', '#ffffff'),
    line: read('--rx-line', '#e5e7eb'),
    ink: read('--rx-ink', '#111827'),
    inkMuted: read('--rx-ink-muted', '#6b7280'),
    inkSubtle: read('--rx-ink-subtle', '#9ca3af'),
  }
}
