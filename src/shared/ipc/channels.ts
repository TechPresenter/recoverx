/**
 * The complete inventory of IPC channel names.
 *
 * Channels are namespaced `<domain>:<verb>` for request/response traffic and
 * `evt:<subject>` for main-to-renderer pushes. The registry asserts at startup
 * that every name listed here has exactly one registered handler, so a typo or a
 * forgotten handler fails loudly during development rather than at runtime in a
 * customer's hands.
 */

export const IpcChannel = {
  // --- Application --------------------------------------------------------
  AppGetInfo: 'app:get-info',
  AppGetDiagnostics: 'app:get-diagnostics',
  AppOpenExternal: 'app:open-external',
  AppRevealPath: 'app:reveal-path',
  AppPickDirectory: 'app:pick-directory',
  AppValidatePath: 'app:validate-path',
  AppRelaunch: 'app:relaunch',

  // --- Window chrome (the frame is custom-drawn) --------------------------
  WindowMinimize: 'window:minimize',
  WindowToggleMaximize: 'window:toggle-maximize',
  WindowClose: 'window:close',
  WindowGetState: 'window:get-state',

  // --- Settings -----------------------------------------------------------
  SettingsGetAll: 'settings:get-all',
  SettingsUpdate: 'settings:update',
  SettingsReset: 'settings:reset',

  // --- Host system --------------------------------------------------------
  SystemGetSnapshot: 'system:get-snapshot',

  // --- Storage devices ----------------------------------------------------
  DiskList: 'disk:list',
  DiskRefresh: 'disk:refresh',

  // --- Updates and crash reports ------------------------------------------
  UpdateGetState: 'update:get-state',
  UpdateCheck: 'update:check',
  UpdateDownload: 'update:download',
  UpdateInstall: 'update:install',
  CrashList: 'crash:list',
  CrashClear: 'crash:clear',
  CrashOpenFolder: 'crash:open-folder',

  // --- Licensing ----------------------------------------------------------
  LicenseGetStatus: 'license:get-status',
  LicenseActivate: 'license:activate',
  LicenseActivateOffline: 'license:activate-offline',
  LicenseDeactivate: 'license:deactivate',
  LicenseCheckRenewal: 'license:check-renewal',

  // --- Drive health -------------------------------------------------------
  HealthGet: 'health:get',
  HealthRefresh: 'health:refresh',
  HealthHistory: 'health:history',

  // --- Lost partitions ----------------------------------------------------
  PartitionSearchStart: 'partition:search-start',
  PartitionSearchCancel: 'partition:search-cancel',
  PartitionSearchGet: 'partition:search-get',
  PartitionAdopt: 'partition:adopt',

  // --- Scanning -----------------------------------------------------------
  ScanStart: 'scan:start',
  ScanPause: 'scan:pause',
  ScanResume: 'scan:resume',
  ScanCancel: 'scan:cancel',
  ScanGetProgress: 'scan:get-progress',
  ScanListSessions: 'scan:list-sessions',
  ScanGetSession: 'scan:get-session',
  ScanDeleteSession: 'scan:delete-session',
  ScanQueryFiles: 'scan:query-files',
  ScanListFolders: 'scan:list-folders',
  ScanSummariseSelection: 'scan:summarise-selection',
  PreviewFile: 'preview:file',

  // --- Recovery -----------------------------------------------------------
  RecoveryCheckDestination: 'recovery:check-destination',
  RecoveryStart: 'recovery:start',
  RecoveryPause: 'recovery:pause',
  RecoveryResume: 'recovery:resume',
  RecoveryCancel: 'recovery:cancel',
  RecoveryGetProgress: 'recovery:get-progress',
  RecoveryListJobs: 'recovery:list-jobs',
  RecoveryListItems: 'recovery:list-items',
  RecoveryDeleteJob: 'recovery:delete-job',

  // --- Diagnostics logs ---------------------------------------------------
  LogsListFiles: 'logs:list-files',
  LogsQuery: 'logs:query',
  LogsOpenFolder: 'logs:open-folder',
  LogsClear: 'logs:clear',
  LogsWrite: 'logs:write',
} as const

export type IpcChannelName = (typeof IpcChannel)[keyof typeof IpcChannel]

export const IPC_CHANNEL_NAMES: readonly IpcChannelName[] = Object.values(IpcChannel)

/**
 * One-way notifications pushed from the main process to every open window.
 */
export const IpcEvent = {
  SettingsChanged: 'evt:settings-changed',
  WindowStateChanged: 'evt:window-state-changed',
  SystemThemeChanged: 'evt:system-theme-changed',
  LogAppended: 'evt:log-appended',
  ScanProgress: 'evt:scan-progress',
  PartitionSearchProgress: 'evt:partition-progress',
  RecoveryProgress: 'evt:recovery-progress',
  UpdateChanged: 'evt:update-changed',
} as const

export type IpcEventName = (typeof IpcEvent)[keyof typeof IpcEvent]

export const IPC_EVENT_NAMES: readonly IpcEventName[] = Object.values(IpcEvent)

/** Runtime guard for values arriving from an untrusted context. */
export function isIpcChannelName(value: unknown): value is IpcChannelName {
  return typeof value === 'string' && (IPC_CHANNEL_NAMES as readonly string[]).includes(value)
}

/** Runtime guard for values arriving from an untrusted context. */
export function isIpcEventName(value: unknown): value is IpcEventName {
  return typeof value === 'string' && (IPC_EVENT_NAMES as readonly string[]).includes(value)
}

/**
 * Hard ceiling on how long the renderer waits for a response.
 *
 * Without it, a wedged main-process handler leaves the UI spinning forever with
 * no way for the user to understand what went wrong.
 *
 * Declared here rather than alongside the schemas so the preload bundle can
 * import it without pulling Zod into a script that runs before every window.
 */
export const IPC_TIMEOUT_MS = 30_000

/**
 * Channels exempt from the timeout because they legitimately block on user
 * interaction — a modal folder picker stays open until the user answers.
 */
export const IPC_UNBOUNDED_CHANNELS: ReadonlySet<IpcChannelName> = new Set<IpcChannelName>([
  IpcChannel.AppPickDirectory,
])

/**
 * Longer ceiling for calls that share the main process with a running scan.
 *
 * A scan holds the event loop in bursts — carving is CPU-bound and the SQLite
 * driver is synchronous — so a query issued mid-scan can wait a while before it
 * is even reached. That is a slow answer, not a wedged handler, and thirty
 * seconds is the wrong ceiling for it.
 *
 * The renderer no longer stacks these requests, so this is a backstop for a
 * genuinely overloaded machine rather than the mechanism that keeps the queue
 * short. It is still bounded: a handler that never returns must eventually
 * surface as an error rather than as a spinner that spins forever.
 */
export const IPC_SLOW_TIMEOUT_MS = 120_000

export const IPC_SLOW_CHANNELS: ReadonlySet<IpcChannelName> = new Set<IpcChannelName>([
  IpcChannel.ScanQueryFiles,
  IpcChannel.ScanListFolders,
  IpcChannel.ScanSummariseSelection,
  IpcChannel.PreviewFile,
  // Enumeration opens every physical device and queries three CIM providers,
  // which on a machine with a failing disk attached can take minutes.
  IpcChannel.DiskList,
  IpcChannel.DiskRefresh,
  IpcChannel.HealthGet,
  IpcChannel.HealthRefresh,
])

/** The ceiling that applies to one channel. */
export function timeoutForChannel(channel: IpcChannelName): number {
  return IPC_SLOW_CHANNELS.has(channel) ? IPC_SLOW_TIMEOUT_MS : IPC_TIMEOUT_MS
}
