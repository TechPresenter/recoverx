import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { RotateCcw } from 'lucide-react'
import { IpcChannel, IpcEvent } from '@shared/ipc/channels'
import type { DeviceInventory } from '@shared/types/disk'
import type { ScanProgress, ScanSession, ScanType } from '@shared/types/scan'
import { allowsScanTypeChoice, modePreset, type RecoveryModeId } from '@shared/types/recovery-mode'
import { PageHeader } from '@/components/layout/PageHeader'
import { Button } from '@/components/ui/Button'
import { Skeleton } from '@/components/ui/Skeleton'
import { invoke, subscribe } from '@/lib/ipc-client'
import { toast } from '@/stores/ui.store'
import { ResultsExplorer } from './ResultsExplorer'
import { ScanProgressPanel } from './ScanProgressPanel'
import { ScanModePicker } from './ScanModePicker'
import { ScanTargetPicker } from './ScanTargetPicker'

/**
 * The scan workflow.
 *
 * Three states, in sequence: choose a target, watch it run, read the results.
 * Results appear as soon as the first batch lands rather than at the end, which
 * is what makes a multi-hour scan tolerable — the file a user is looking for is
 * often found in the first minute.
 */
/**
 * How often the results list refreshes while a scan is running.
 *
 * Fast enough that a user watching sees their files appear, slow enough that
 * the queries never stack up behind the scanner's own work.
 */
const RESULTS_REFRESH_INTERVAL_MS = 1500

export function ScanPage() {
  const { t } = useTranslation()

  const [inventory, setInventory] = useState<DeviceInventory | null>(null)
  const [session, setSession] = useState<ScanSession | null>(null)
  const [progress, setProgress] = useState<ScanProgress | null>(null)
  const [selection, setSelection] = useState<{ deviceId: string; partitionId: string } | null>(null)
  const [includeExisting, setIncludeExisting] = useState(false)
  const [scanType, setScanType] = useState<ScanType>('quick')
  const [mode, setMode] = useState<RecoveryModeId | null>(null)
  const [deviceId, setDeviceId] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  /**
   * Bumped when the file count changes, to re-query results.
   *
   * Keyed on the count rather than on every progress tick: progress arrives four
   * times a second, and re-running the results query that often would keep the
   * database busy for no visible benefit.
   */
  const [revision, setRevision] = useState(0)
  const lastFileCount = useRef(0)
  /** When the results were last asked to refresh. */
  const lastRefreshAt = useRef(0)

  useEffect(() => {
    void (async () => {
      const response = await invoke(IpcChannel.DiskList, undefined)

      if (!response.ok) {
        toast.error(response.error.message, response.error.details)
        return
      }

      setInventory(response.data)
    })()
  }, [])

  useEffect(
    () =>
      subscribe(IpcEvent.ScanProgress, (next) => {
        setProgress((current) =>
          current === null || current.sessionId === next.sessionId ? next : current,
        )

        /*
         * Throttled, and deliberately not tied to the progress rate.
         *
         * Progress arrives four times a second. Refreshing the results that
         * often runs three database queries per tick against a table the
         * scanner is still writing to, which is both invisible to the user —
         * nobody reads a list that is repainting four times a second — and the
         * cause of a request backlog that used to end in a timeout.
         *
         * The scan ending always refreshes, throttle or not. Otherwise the last
         * files found would sit in the database unshown until something else
         * happened to trigger a query, and the user would be looking at a list
         * that is quietly missing its final rows.
         */
        const finished = next.status !== 'running' && next.status !== 'paused'
        const foundMore = next.filesFound !== lastFileCount.current
        const now = Date.now()

        // The completion refresh is unconditional rather than gated on the
        // count changing: the usual ending is a final tick carrying the same
        // total as the one before it, and gating on a change would skip exactly
        // the refresh that shows the finished list.
        if (finished || (foundMore && now - lastRefreshAt.current >= RESULTS_REFRESH_INTERVAL_MS)) {
          lastFileCount.current = next.filesFound
          lastRefreshAt.current = now
          setRevision((value) => value + 1)
        }
      }),
    [],
  )

  /**
   * Applying a mode overwrites the derived settings and clears the target.
   *
   * A partition chosen for a quick scan is not necessarily a valid target for a
   * device-level deep scan, so carrying it across would silently start the wrong
   * scan.
   */
  const chooseMode = useCallback((next: RecoveryModeId) => {
    const preset = modePreset(next)

    setMode(next)
    setScanType(preset.scanType)
    setIncludeExisting(preset.includeExisting)
    setSelection(null)
    setDeviceId(null)
  }, [])

  const start = useCallback(async (): Promise<void> => {
    const preset = mode === null ? null : modePreset(mode)
    const wholeDevice = preset?.target === 'device'

    // A device-level scan has no partition; a volume-level one must have both.
    const target = wholeDevice
      ? deviceId === null
        ? null
        : { deviceId, partitionId: null }
      : selection

    if (target === null) return

    setBusy(true)

    const response = await invoke(IpcChannel.ScanStart, {
      deviceId: target.deviceId,
      partitionId: target.partitionId,
      scanType,
      includeExisting,
    })

    setBusy(false)

    if (!response.ok) {
      toast.error(response.error.message, response.error.details)
      return
    }

    lastFileCount.current = 0
    setSession(response.data)
    setProgress({
      sessionId: response.data.id,
      status: 'running',
      processed: 0,
      total: 0,
      filesFound: 0,
      bytesFound: 0,
      elapsedMs: 0,
      estimatedRemainingMs: null,
      filesPerSecond: 0,
    })
  }, [selection, deviceId, mode, includeExisting, scanType])

  const control = useCallback(
    async (
      channel:
        typeof IpcChannel.ScanPause | typeof IpcChannel.ScanResume | typeof IpcChannel.ScanCancel,
    ): Promise<void> => {
      if (session === null) return

      setBusy(true)
      const response = await invoke(channel, { sessionId: session.id })
      setBusy(false)

      if (!response.ok) toast.error(response.error.message, response.error.details)
    },
    [session],
  )

  const reset = useCallback(() => {
    setSession(null)
    setProgress(null)
    setMode(null)
    setSelection(null)
    setDeviceId(null)
    lastFileCount.current = 0
  }, [])

  return (
    <div className="space-y-6">
      <PageHeader
        title={mode === null && session === null ? t('modes.title') : t('scan.title')}
        description={mode === null && session === null ? t('modes.subtitle') : t('scan.subtitle')}
        actions={
          (session !== null || mode !== null) && (
            <Button
              size="sm"
              variant="secondary"
              iconLeft={<RotateCcw size={14} />}
              onClick={reset}
            >
              {session === null ? t('modes.change') : t('scan.newScan')}
            </Button>
          )
        }
      />

      {session === null ? (
        mode === null ? (
          <ScanModePicker selected={mode} onSelect={chooseMode} />
        ) : inventory === null ? (
          <div className="space-y-4">
            {Array.from({ length: 2 }, (_, index) => (
              <Skeleton key={index} className="h-40 w-full" />
            ))}
          </div>
        ) : (
          <ScanTargetPicker
            inventory={inventory}
            selectedPartitionId={selection?.partitionId ?? null}
            scanType={scanType}
            onScanTypeChange={setScanType}
            target={modePreset(mode).target}
            allowScanTypeChoice={allowsScanTypeChoice(mode)}
            selectedDeviceId={deviceId}
            onSelectDevice={setDeviceId}
            includeExisting={includeExisting}
            starting={busy}
            onSelect={(nextDeviceId, partitionId) => {
              setSelection({ deviceId: nextDeviceId, partitionId })
            }}
            onIncludeExistingChange={setIncludeExisting}
            onStart={() => {
              void start()
            }}
          />
        )
      ) : (
        <>
          {progress !== null && (
            <ScanProgressPanel
              session={session}
              progress={progress}
              busy={busy}
              onPause={() => {
                void control(IpcChannel.ScanPause)
              }}
              onResume={() => {
                void control(IpcChannel.ScanResume)
              }}
              onCancel={() => {
                void control(IpcChannel.ScanCancel)
              }}
            />
          )}

          <ResultsExplorer sessionId={session.id} revision={revision} />
        </>
      )}
    </div>
  )
}
