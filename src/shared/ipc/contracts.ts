import { z } from 'zod'
import {
  LogCleanupResultSchema,
  LogEntrySchema,
  LogFileInfoSchema,
  LogQueryResultSchema,
  LogQuerySchema,
  RendererLogRecordSchema,
} from '../types/logging'
import { DeviceInventorySchema, StorageDeviceSchema } from '../types/disk'
import { HealthHistoryPointSchema, HealthReportSchema } from '../types/health'
import { CrashReportSchema, UpdateStateSchema } from '../types/diagnostics'
import { LicenseStatusSchema } from '../types/license'
import {
  PartitionSearchProgressSchema,
  PartitionSearchResultSchema,
  PartitionSearchScopeSchema,
} from '../types/partition-search'
import {
  RecoveryItemFilterSchema,
  RecoveryItemSchema,
  RecoveryJobSchema,
  RecoveryProgressSchema,
  StartRecoveryRequestSchema,
} from '../types/recovery'
import {
  FileFilterSchema,
  FileQueryResultSchema,
  FilePreviewSchema,
  FolderNodeSchema,
  ScanProgressSchema,
  ScanSessionSchema,
  ScanTypeSchema,
  SelectionSchema,
  SelectionSummarySchema,
} from '../types/scan'
import { AppSettingsPatchSchema, AppSettingsSchema } from '../types/settings'
import {
  AppInfoSchema,
  DiagnosticsSchema,
  DirectoryPickResultSchema,
  PathValidationSchema,
  SystemSnapshotSchema,
  WindowStateSchema,
} from '../types/system'
import { IpcChannel, IpcEvent, type IpcChannelName, type IpcEventName } from './channels'

/**
 * The IPC wire contract.
 *
 * Every channel declares a request schema and a response schema. Both are
 * enforced at runtime in the main process, and both are the source of the
 * TypeScript types used by the renderer — there is no second, hand-written type
 * declaration that could fall out of sync.
 *
 * Why validate at all when both ends are our own code: the renderer runs
 * attacker-reachable content (previewed file names, metadata extracted from
 * untrusted disk images). Treating everything arriving on `ipcMain.handle` as
 * hostile input is the boundary that keeps a renderer compromise from becoming
 * arbitrary main-process behaviour.
 */

export interface IpcContract {
  readonly request: z.ZodType
  readonly response: z.ZodType
}

/** Empty payload marker. `z.void()` accepts `undefined` and infers `void`, which lets call sites omit the argument entirely. */
const NO_PAYLOAD = z.void()

/** Non-empty absolute path. Deeper validation happens in the handler, against the real filesystem. */
const PathSchema = z.string().min(1).max(32_767)

export const IPC_CONTRACTS = {
  // --- Application --------------------------------------------------------
  [IpcChannel.AppGetInfo]: {
    request: NO_PAYLOAD,
    response: AppInfoSchema,
  },
  [IpcChannel.AppGetDiagnostics]: {
    request: NO_PAYLOAD,
    response: DiagnosticsSchema,
  },
  [IpcChannel.AppOpenExternal]: {
    // The URL is re-checked against ALLOWED_EXTERNAL_HOSTS in the handler; the
    // schema only bounds the size so a hostile renderer cannot send a megabyte.
    request: z.object({ url: z.string().min(1).max(2048) }),
    response: NO_PAYLOAD,
  },
  [IpcChannel.AppRevealPath]: {
    request: z.object({ path: PathSchema }),
    response: NO_PAYLOAD,
  },
  [IpcChannel.AppPickDirectory]: {
    request: z.object({
      title: z.string().max(200).optional(),
      defaultPath: PathSchema.optional(),
    }),
    response: DirectoryPickResultSchema,
  },
  [IpcChannel.AppValidatePath]: {
    request: z.object({ path: PathSchema }),
    response: PathValidationSchema,
  },
  [IpcChannel.AppRelaunch]: {
    request: NO_PAYLOAD,
    response: NO_PAYLOAD,
  },

  // --- Window chrome ------------------------------------------------------
  [IpcChannel.WindowMinimize]: {
    request: NO_PAYLOAD,
    response: NO_PAYLOAD,
  },
  [IpcChannel.WindowToggleMaximize]: {
    request: NO_PAYLOAD,
    response: WindowStateSchema,
  },
  [IpcChannel.WindowClose]: {
    request: NO_PAYLOAD,
    response: NO_PAYLOAD,
  },
  [IpcChannel.WindowGetState]: {
    request: NO_PAYLOAD,
    response: WindowStateSchema,
  },

  // --- Settings -----------------------------------------------------------
  [IpcChannel.SettingsGetAll]: {
    request: NO_PAYLOAD,
    response: AppSettingsSchema,
  },
  [IpcChannel.SettingsUpdate]: {
    request: z.object({ patch: AppSettingsPatchSchema }),
    response: AppSettingsSchema,
  },
  [IpcChannel.SettingsReset]: {
    request: NO_PAYLOAD,
    response: AppSettingsSchema,
  },

  // --- Host system --------------------------------------------------------
  [IpcChannel.SystemGetSnapshot]: {
    request: NO_PAYLOAD,
    response: SystemSnapshotSchema,
  },

  // --- Storage devices ----------------------------------------------------
  [IpcChannel.DiskList]: {
    // Serves the cached inventory when one exists, so navigating back to the
    // device list does not re-run a multi-second enumeration.
    request: NO_PAYLOAD,
    response: DeviceInventorySchema,
  },
  [IpcChannel.DiskRefresh]: {
    request: NO_PAYLOAD,
    response: DeviceInventorySchema,
  },

  // --- Scanning -----------------------------------------------------------
  [IpcChannel.UpdateGetState]: {
    request: NO_PAYLOAD,
    response: UpdateStateSchema,
  },
  [IpcChannel.UpdateCheck]: {
    request: NO_PAYLOAD,
    response: UpdateStateSchema,
  },
  [IpcChannel.UpdateDownload]: {
    request: NO_PAYLOAD,
    response: UpdateStateSchema,
  },
  [IpcChannel.UpdateInstall]: {
    request: NO_PAYLOAD,
    response: NO_PAYLOAD,
  },
  [IpcChannel.CrashList]: {
    request: NO_PAYLOAD,
    response: z.array(CrashReportSchema),
  },
  [IpcChannel.CrashClear]: {
    request: NO_PAYLOAD,
    response: z.object({ removed: z.number().int() }),
  },
  [IpcChannel.CrashOpenFolder]: {
    request: NO_PAYLOAD,
    response: NO_PAYLOAD,
  },

  [IpcChannel.LicenseGetStatus]: {
    request: NO_PAYLOAD,
    response: LicenseStatusSchema,
  },
  [IpcChannel.LicenseActivate]: {
    request: z.object({ key: z.string().min(1).max(64) }),
    response: LicenseStatusSchema,
  },
  [IpcChannel.LicenseActivateOffline]: {
    request: z.object({ token: z.string().min(1).max(8192) }),
    response: LicenseStatusSchema,
  },
  [IpcChannel.LicenseDeactivate]: {
    request: NO_PAYLOAD,
    response: LicenseStatusSchema,
  },
  // `renewed` is stated rather than inferred by the screen from the dates:
  // "nothing newer on the server" and "extended by a day" need different words.
  [IpcChannel.LicenseCheckRenewal]: {
    request: NO_PAYLOAD,
    response: z.object({ renewed: z.boolean(), status: LicenseStatusSchema }),
  },

  [IpcChannel.HealthGet]: {
    request: NO_PAYLOAD,
    response: HealthReportSchema,
  },
  [IpcChannel.HealthRefresh]: {
    request: NO_PAYLOAD,
    response: HealthReportSchema,
  },
  [IpcChannel.HealthHistory]: {
    request: z.object({
      deviceId: z.string().min(1),
      limit: z.number().int().positive().max(2000).optional(),
    }),
    response: z.array(HealthHistoryPointSchema),
  },

  [IpcChannel.PartitionSearchStart]: {
    request: z.object({
      deviceId: z.string().min(1),
      scope: PartitionSearchScopeSchema,
    }),
    response: PartitionSearchResultSchema,
  },
  [IpcChannel.PartitionSearchCancel]: {
    request: z.object({ searchId: z.string().min(1) }),
    response: NO_PAYLOAD,
  },
  [IpcChannel.PartitionSearchGet]: {
    request: z.object({ searchId: z.string().min(1) }),
    response: PartitionSearchResultSchema,
  },
  [IpcChannel.PartitionAdopt]: {
    request: z.object({ searchId: z.string().min(1) }),
    response: StorageDeviceSchema,
  },

  [IpcChannel.ScanStart]: {
    request: z.object({
      deviceId: z.string().min(1),
      partitionId: z.string().min(1).nullable(),
      scanType: ScanTypeSchema,
      includeExisting: z.boolean(),
    }),
    response: ScanSessionSchema,
  },
  [IpcChannel.ScanPause]: {
    request: z.object({ sessionId: z.string().min(1) }),
    response: NO_PAYLOAD,
  },
  [IpcChannel.ScanResume]: {
    request: z.object({ sessionId: z.string().min(1) }),
    response: NO_PAYLOAD,
  },
  [IpcChannel.ScanCancel]: {
    request: z.object({ sessionId: z.string().min(1) }),
    response: NO_PAYLOAD,
  },
  [IpcChannel.ScanGetProgress]: {
    request: z.object({ sessionId: z.string().min(1) }),
    response: ScanProgressSchema.nullable(),
  },
  [IpcChannel.ScanListSessions]: {
    request: NO_PAYLOAD,
    response: z.array(ScanSessionSchema),
  },
  [IpcChannel.ScanGetSession]: {
    request: z.object({ sessionId: z.string().min(1) }),
    response: ScanSessionSchema.nullable(),
  },
  [IpcChannel.ScanDeleteSession]: {
    request: z.object({ sessionId: z.string().min(1) }),
    response: NO_PAYLOAD,
  },
  [IpcChannel.ScanQueryFiles]: {
    request: FileFilterSchema,
    response: FileQueryResultSchema,
  },
  [IpcChannel.ScanListFolders]: {
    request: z.object({ sessionId: z.string().min(1) }),
    response: z.array(FolderNodeSchema),
  },
  [IpcChannel.ScanSummariseSelection]: {
    request: SelectionSchema,
    response: SelectionSummarySchema,
  },

  // --- Preview ------------------------------------------------------------
  [IpcChannel.PreviewFile]: {
    request: z.object({ fileId: z.string().min(1) }),
    response: FilePreviewSchema,
  },

  // --- Recovery -----------------------------------------------------------
  [IpcChannel.RecoveryCheckDestination]: {
    request: z.object({ selection: SelectionSchema, destination: z.string().min(1) }),
    response: z.object({
      path: z.string(),
      isUsable: z.boolean(),
      problem: z.string().nullable(),
      message: z.string(),
      freeBytes: z.number(),
      totalBytes: z.number(),
    }),
  },
  [IpcChannel.RecoveryStart]: {
    request: StartRecoveryRequestSchema,
    response: RecoveryJobSchema,
  },
  [IpcChannel.RecoveryPause]: {
    request: z.object({ jobId: z.string().min(1) }),
    response: NO_PAYLOAD,
  },
  [IpcChannel.RecoveryResume]: {
    request: z.object({ jobId: z.string().min(1) }),
    response: NO_PAYLOAD,
  },
  [IpcChannel.RecoveryCancel]: {
    request: z.object({ jobId: z.string().min(1) }),
    response: NO_PAYLOAD,
  },
  [IpcChannel.RecoveryGetProgress]: {
    request: z.object({ jobId: z.string().min(1) }),
    response: RecoveryProgressSchema.nullable(),
  },
  [IpcChannel.RecoveryListJobs]: {
    request: NO_PAYLOAD,
    response: z.array(RecoveryJobSchema),
  },
  [IpcChannel.RecoveryListItems]: {
    request: RecoveryItemFilterSchema,
    response: z.array(RecoveryItemSchema),
  },
  [IpcChannel.RecoveryDeleteJob]: {
    request: z.object({ jobId: z.string().min(1) }),
    response: NO_PAYLOAD,
  },

  // --- Diagnostics logs ---------------------------------------------------
  [IpcChannel.LogsListFiles]: {
    request: NO_PAYLOAD,
    response: z.array(LogFileInfoSchema),
  },
  [IpcChannel.LogsQuery]: {
    request: LogQuerySchema,
    response: LogQueryResultSchema,
  },
  [IpcChannel.LogsOpenFolder]: {
    request: NO_PAYLOAD,
    response: NO_PAYLOAD,
  },
  [IpcChannel.LogsClear]: {
    request: NO_PAYLOAD,
    response: LogCleanupResultSchema,
  },
  [IpcChannel.LogsWrite]: {
    request: RendererLogRecordSchema,
    response: NO_PAYLOAD,
  },
} as const satisfies Record<IpcChannelName, IpcContract>

type IpcContractMap = typeof IPC_CONTRACTS

/** Request payload type for a channel, inferred from its schema. */
export type IpcRequest<C extends IpcChannelName> = z.infer<IpcContractMap[C]['request']>

/** Response payload type for a channel, inferred from its schema. */
export type IpcResponse<C extends IpcChannelName> = z.infer<IpcContractMap[C]['response']>

/** Look up the contract for a channel. */
export function getContract<C extends IpcChannelName>(channel: C): IpcContractMap[C] {
  return IPC_CONTRACTS[channel]
}

/**
 * Payload schemas for main-to-renderer notifications.
 */
export const IPC_EVENT_CONTRACTS = {
  [IpcEvent.SettingsChanged]: AppSettingsSchema,
  [IpcEvent.WindowStateChanged]: WindowStateSchema,
  [IpcEvent.SystemThemeChanged]: z.object({ shouldUseDarkColors: z.boolean() }),
  [IpcEvent.LogAppended]: z.array(LogEntrySchema),
  [IpcEvent.ScanProgress]: ScanProgressSchema,
  [IpcEvent.RecoveryProgress]: RecoveryProgressSchema,
  [IpcEvent.PartitionSearchProgress]: PartitionSearchProgressSchema,
  [IpcEvent.UpdateChanged]: UpdateStateSchema,
} as const satisfies Record<IpcEventName, z.ZodType>

type IpcEventContractMap = typeof IPC_EVENT_CONTRACTS

/** Payload type for a main-to-renderer event, inferred from its schema. */
export type IpcEventPayload<E extends IpcEventName> = z.infer<IpcEventContractMap[E]>
