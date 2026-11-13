import { join } from 'node:path'
import { BrowserWindow, nativeTheme, screen } from 'electron'
import { APP_NAME } from '@shared/constants/app'
import type { IpcEventName } from '@shared/ipc/channels'
import type { IpcEventPayload } from '@shared/ipc/contracts'
import type { WindowState } from '@shared/types/system'
import { clamp } from '@shared/utils/guards'
import type { RuntimeConfig } from '../config/runtime'
import type {
  PersistedWindowState,
  WindowStateRepository,
} from '../database/repositories/window-state.repository'
import type { Logger } from '../logging/logger'
import { APP_INDEX_URL } from '../security/app-protocol'
import { guardWebContents } from '../security/navigation-guard'
import type { StartupMetrics } from './startup-metrics'

/**
 * Creation and lifecycle of application windows.
 *
 * The frame is drawn by the renderer (`frame: false`) so the title bar can carry
 * the search field and scan status the way every commercial recovery suite does.
 * That means window controls arrive over IPC, and it means this class owns the
 * geometry that the OS would otherwise manage.
 */

const DEFAULT_WIDTH = 1280
const DEFAULT_HEIGHT = 820
const MIN_WIDTH = 1024
const MIN_HEIGHT = 660

/** Debounce for geometry persistence — resize fires on every frame of a drag. */
const PERSIST_DEBOUNCE_MS = 400

export interface WindowManagerOptions {
  readonly config: RuntimeConfig
  readonly logger: Logger
  readonly windowState: WindowStateRepository
  readonly startup: StartupMetrics
  readonly preloadPath: string
  readonly launchMinimized: boolean
  /** Notified when a window's renderer process dies. */
  readonly onRendererGone?: ((reason: string, exitCode: number) => void) | undefined
}

export class WindowManager {
  private readonly options: WindowManagerOptions
  private readonly logger: Logger
  private mainWindow: BrowserWindow | null = null
  private persistTimer: NodeJS.Timeout | null = null

  constructor(options: WindowManagerOptions) {
    this.options = options
    this.logger = options.logger.child('window')
  }

  /** The main window, or `null` before creation / after close. */
  getMainWindow(): BrowserWindow | null {
    return this.mainWindow !== null && !this.mainWindow.isDestroyed() ? this.mainWindow : null
  }

  /**
   * Create the main window, or focus it if it already exists.
   * Called on launch and again when a second instance is blocked.
   */
  createMainWindow(): BrowserWindow {
    const existing = this.getMainWindow()
    if (existing !== null) {
      this.focus()
      return existing
    }

    const bounds = this.resolveInitialBounds()

    const window = new BrowserWindow({
      width: bounds.width,
      height: bounds.height,
      minWidth: MIN_WIDTH,
      minHeight: MIN_HEIGHT,
      // Painting the window in the theme colour before the renderer loads is
      // what removes the white flash on launch.
      backgroundColor: nativeTheme.shouldUseDarkColors ? '#0B0F17' : '#F6F8FB',
      // Deferred until `ready-to-show`, so the user never sees an empty frame.
      show: false,
      frame: false,
      title: APP_NAME,
      autoHideMenuBar: true,
      webPreferences: {
        preload: this.options.preloadPath,
        // The three settings that make the renderer a genuine security boundary.
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webviewTag: false,
        // Spell-check downloads dictionaries from Google's CDN, which the
        // outbound request filter blocks anyway; disabling it avoids the noise.
        spellcheck: false,
        devTools: this.options.config.isDevelopment,
      },
    })

    if (bounds.x !== null && bounds.y !== null) {
      window.setPosition(bounds.x, bounds.y)
    } else {
      window.center()
    }

    if (bounds.isMaximized) window.maximize()

    this.mainWindow = window
    this.attachLifecycle(window)

    guardWebContents({
      contents: window.webContents,
      config: this.options.config,
      logger: this.options.logger,
      onRendererGone: this.options.onRendererGone,
    })

    void this.loadRenderer(window)

    return window
  }

  /** Bring the main window forward, restoring it if minimised. */
  focus(): void {
    const window = this.getMainWindow()
    if (window === null) return

    if (window.isMinimized()) window.restore()
    window.show()
    window.focus()
  }

  /** Current state of the main window, for the custom title bar. */
  getState(): WindowState {
    const window = this.getMainWindow()

    if (window === null) {
      return { isMaximized: false, isMinimized: false, isFullScreen: false, isFocused: false }
    }

    return {
      isMaximized: window.isMaximized(),
      isMinimized: window.isMinimized(),
      isFullScreen: window.isFullScreen(),
      isFocused: window.isFocused(),
    }
  }

  minimize(): void {
    this.getMainWindow()?.minimize()
  }

  toggleMaximize(): WindowState {
    const window = this.getMainWindow()
    if (window === null) return this.getState()

    if (window.isMaximized()) window.unmaximize()
    else window.maximize()

    return this.getState()
  }

  close(): void {
    this.getMainWindow()?.close()
  }

  /**
   * Push an event to every open window.
   *
   * Typed against the event contract so a payload can never drift from what the
   * renderer's subscriber expects.
   */
  broadcast<E extends IpcEventName>(event: E, payload: IpcEventPayload<E>): void {
    for (const window of BrowserWindow.getAllWindows()) {
      if (window.isDestroyed()) continue

      try {
        window.webContents.send(event, payload)
      } catch {
        // The window may be tearing down between the check and the send.
      }
    }
  }

  /** Persist geometry and release timers. Called during shutdown. */
  dispose(): void {
    if (this.persistTimer !== null) {
      clearTimeout(this.persistTimer)
      this.persistTimer = null
    }
    this.persistGeometry()
  }

  // --- internals -----------------------------------------------------------

  private async loadRenderer(window: BrowserWindow): Promise<void> {
    const devServerUrl = this.options.config.rendererDevServerUrl

    try {
      if (devServerUrl !== null) {
        await window.loadURL(devServerUrl)
      } else {
        await window.loadURL(APP_INDEX_URL)
      }
    } catch (error) {
      this.logger.error('Failed to load the renderer', { error: String(error) })
    }
  }

  private attachLifecycle(window: BrowserWindow): void {
    window.once('ready-to-show', () => {
      this.options.startup.markFirstPaint()

      if (this.options.launchMinimized) {
        window.showInactive()
        window.minimize()
      } else {
        window.show()
      }

      this.logger.info('Main window ready', {
        startupMs: this.options.startup.startupMs,
      })

      if (this.options.config.openDevToolsOnStart) {
        window.webContents.openDevTools({ mode: 'detach' })
      }
    })

    const schedulePersist = (): void => {
      this.schedulePersistGeometry()
    }

    window.on('resize', schedulePersist)
    window.on('move', schedulePersist)

    // Registered one by one rather than through a loop: Electron types each
    // event name as a separate overload, so a union of names does not typecheck.
    const onStateChanged = (): void => {
      this.schedulePersistGeometry()
      this.broadcast('evt:window-state-changed', this.getState())
    }

    window.on('maximize', onStateChanged)
    window.on('unmaximize', onStateChanged)
    window.on('minimize', onStateChanged)
    window.on('restore', onStateChanged)
    window.on('focus', onStateChanged)
    window.on('blur', onStateChanged)

    window.on('close', () => {
      // Persist synchronously here: the debounced timer will not survive the
      // window being destroyed, so a resize immediately before quitting would
      // otherwise be lost.
      this.persistGeometry()
    })

    window.on('closed', () => {
      this.mainWindow = null
    })

    window.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL) => {
      this.logger.error('Renderer failed to load', { errorCode, errorDescription, validatedURL })
    })

    window.webContents.on('unresponsive', () => {
      this.logger.warn('Renderer became unresponsive')
    })

    window.webContents.on('responsive', () => {
      this.logger.info('Renderer became responsive again')
    })
  }

  private schedulePersistGeometry(): void {
    if (this.persistTimer !== null) clearTimeout(this.persistTimer)

    this.persistTimer = setTimeout(() => {
      this.persistTimer = null
      this.persistGeometry()
    }, PERSIST_DEBOUNCE_MS)

    this.persistTimer.unref()
  }

  private persistGeometry(): void {
    const window = this.getMainWindow()
    if (window === null) return

    const isMaximized = window.isMaximized()
    // `getNormalBounds` reports the restored geometry even while maximised,
    // which is what should be restored when the user un-maximises later.
    const bounds = window.getNormalBounds()

    this.options.windowState.write({
      x: bounds.x,
      y: bounds.y,
      width: bounds.width,
      height: bounds.height,
      isMaximized,
    })
  }

  /**
   * Decide where the window should open.
   *
   * A saved position is only honoured if it still lands on a connected display.
   * Restoring a window to a monitor that has since been unplugged puts it
   * off-screen with no way to retrieve it — a genuinely stuck state for the user.
   */
  private resolveInitialBounds(): PersistedWindowState {
    const fallback: PersistedWindowState = {
      x: null,
      y: null,
      width: DEFAULT_WIDTH,
      height: DEFAULT_HEIGHT,
      isMaximized: false,
    }

    const saved = this.options.windowState.read()
    if (saved === null) return fallback

    const width = clamp(saved.width, MIN_WIDTH, 10_000)
    const height = clamp(saved.height, MIN_HEIGHT, 10_000)

    if (saved.x === null || saved.y === null) {
      return { x: null, y: null, width, height, isMaximized: saved.isMaximized }
    }

    if (!isVisibleOnAnyDisplay(saved.x, saved.y, width, height)) {
      this.logger.info('Discarded saved window position: no longer on a connected display', {
        x: saved.x,
        y: saved.y,
      })
      return { x: null, y: null, width, height, isMaximized: saved.isMaximized }
    }

    return { x: saved.x, y: saved.y, width, height, isMaximized: saved.isMaximized }
  }
}

/**
 * `true` when a meaningful portion of the window rectangle overlaps a display.
 *
 * A strict containment check would reject the common and legitimate case of a
 * window deliberately straddling two monitors.
 */
function isVisibleOnAnyDisplay(x: number, y: number, width: number, height: number): boolean {
  const MIN_VISIBLE_PX = 80

  return screen.getAllDisplays().some((display) => {
    const area = display.workArea

    const overlapX = Math.min(x + width, area.x + area.width) - Math.max(x, area.x)
    const overlapY = Math.min(y + height, area.y + area.height) - Math.max(y, area.y)

    return overlapX >= MIN_VISIBLE_PX && overlapY >= MIN_VISIBLE_PX
  })
}

/** Resolve the preload script path for the current build layout. */
export function resolvePreloadPath(): string {
  // electron-vite emits main and preload as siblings under `out/`.
  return join(__dirname, '../preload/index.js')
}
