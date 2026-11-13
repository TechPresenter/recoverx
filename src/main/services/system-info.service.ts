import { execFile } from 'node:child_process'
import os, { type CpuInfo } from 'node:os'
import { promisify } from 'node:util'
import type { SystemSnapshot } from '@shared/types/system'

/**
 * Host machine telemetry for the Dashboard and for support bundles.
 *
 * Everything here is read from Node's `os` module rather than a native
 * dependency. Device enumeration, SMART attributes and partition tables are a
 * different concern entirely and arrive with the Disk Detection module.
 */

const execFileAsync = promisify(execFile)

interface CpuSample {
  readonly idle: number
  readonly total: number
}

let previousCpuSample: CpuSample | null = null
let cachedElevation: boolean | null = null

/**
 * Capture a point-in-time snapshot of the host.
 *
 * CPU utilisation is derived from the delta against the previous call, which is
 * the only way to get a meaningful figure from `os.cpus()` — the raw values are
 * cumulative tick counters since boot, so a single reading describes the machine's
 * entire uptime rather than the present moment. The first call therefore reports
 * `null` rather than a misleading number.
 */
export async function captureSystemSnapshot(): Promise<SystemSnapshot> {
  const cpus = os.cpus()
  const sample = sampleCpu(cpus)
  const utilizationPercent = computeUtilization(previousCpuSample, sample)
  previousCpuSample = sample

  const totalMemory = os.totalmem()
  const freeMemory = os.freemem()
  const usedMemory = totalMemory - freeMemory

  const memoryUsage = process.memoryUsage()

  return {
    capturedAt: Date.now(),
    os: {
      platform: process.platform,
      distro: resolveDistroName(),
      release: os.release(),
      arch: process.arch,
      hostname: os.hostname(),
      uptimeMs: Math.round(os.uptime() * 1000),
    },
    cpu: {
      model: cpus[0]?.model.trim() ?? 'Unknown processor',
      logicalCores: cpus.length,
      speedMhz: cpus[0]?.speed ?? 0,
      utilizationPercent,
    },
    memory: {
      totalBytes: totalMemory,
      freeBytes: freeMemory,
      usedBytes: usedMemory,
      usagePercent: totalMemory > 0 ? (usedMemory / totalMemory) * 100 : 0,
    },
    process: {
      uptimeMs: Math.round(process.uptime() * 1000),
      rssBytes: memoryUsage.rss,
      heapUsedBytes: memoryUsage.heapUsed,
      heapTotalBytes: memoryUsage.heapTotal,
      externalBytes: memoryUsage.external,
    },
    isElevated: await isProcessElevated(),
  }
}

/**
 * Number of worker threads a scan may use.
 *
 * One core is reserved for the main process and the compositor: saturating every
 * core makes the progress UI stutter, and a scan that *looks* hung is a support
 * ticket regardless of how fast it actually is.
 */
export function recommendedWorkerCount(): number {
  return Math.max(1, os.cpus().length - 1)
}

/**
 * Whether the process holds an elevated (Administrator) token.
 *
 * Raw block-device access requires it, so the Dashboard surfaces the state
 * rather than letting a scan fail later with an opaque permission error.
 *
 * `fltmc` is a filter-manager control tool that refuses to run without
 * elevation; its exit status is the cheapest reliable signal on Windows.
 * `fs.access(W_OK)` is not usable here — on Windows it reflects only the
 * read-only attribute and ignores ACLs entirely.
 */
export async function isProcessElevated(): Promise<boolean> {
  if (cachedElevation !== null) return cachedElevation

  if (process.platform !== 'win32') {
    // On POSIX the question is simply whether the effective uid is root.
    cachedElevation = typeof process.getuid === 'function' ? process.getuid() === 0 : false
    return cachedElevation
  }

  try {
    await execFileAsync('fltmc.exe', ['filters'], {
      windowsHide: true,
      timeout: 4000,
    })
    cachedElevation = true
  } catch {
    cachedElevation = false
  }

  return cachedElevation
}

/** Clear the cached elevation result. Used by tests. */
export function resetElevationCache(): void {
  cachedElevation = null
}

// --- internals -------------------------------------------------------------

function sampleCpu(cpus: readonly CpuInfo[]): CpuSample {
  let idle = 0
  let total = 0

  for (const cpu of cpus) {
    idle += cpu.times.idle
    total += cpu.times.user + cpu.times.nice + cpu.times.sys + cpu.times.idle + cpu.times.irq
  }

  return { idle, total }
}

function computeUtilization(previous: CpuSample | null, current: CpuSample): number | null {
  if (previous === null) return null

  const totalDelta = current.total - previous.total
  const idleDelta = current.idle - previous.idle

  // A zero delta means two samples landed within the same scheduler tick; there
  // is no information to report yet.
  if (totalDelta <= 0) return null

  const utilization = (1 - idleDelta / totalDelta) * 100
  return Math.min(100, Math.max(0, Number(utilization.toFixed(1))))
}

let cachedDistro: string | null = null

/**
 * Marketing name of the operating system.
 *
 * `os.release()` returns a build number ("10.0.26200"), which is meaningless in
 * a support conversation. Windows 11 still reports a 10.0 kernel version, so the
 * distinction has to come from the build number: 22000 is the first Windows 11
 * build.
 */
function resolveDistroName(): string {
  if (cachedDistro !== null) return cachedDistro

  if (process.platform !== 'win32') {
    cachedDistro = `${os.type()} ${os.release()}`
    return cachedDistro
  }

  const build = Number.parseInt(os.release().split('.')[2] ?? '0', 10)
  const family = Number.isFinite(build) && build >= 22000 ? 'Windows 11' : 'Windows 10'

  cachedDistro = `${family} (build ${Number.isFinite(build) ? build : 'unknown'})`
  return cachedDistro
}
