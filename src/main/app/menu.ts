import { Menu, type MenuItemConstructorOptions } from 'electron'
import { DOCS_URL, WEBSITE_URL } from '@shared/constants/app'
import type { RuntimeConfig } from '../config/runtime'
import type { Logger } from '../logging/logger'
import { openExternalUrl } from '../security/navigation-guard'

/**
 * Application menu.
 *
 * The window is frameless and the menu bar is hidden, so this exists almost
 * entirely to keep the standard editing and zoom *accelerators* alive — without
 * an application menu, Ctrl+C, Ctrl+V and Ctrl+A stop working in text fields,
 * which users correctly read as the app being broken.
 *
 * Developer tooling is only attached in unpackaged builds: a shipped copy must
 * not offer a DevTools window that could be used to inspect a licence check.
 */
export function installApplicationMenu(config: RuntimeConfig, logger: Logger): void {
  const template: MenuItemConstructorOptions[] = [
    {
      label: '&Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
    {
      label: '&View',
      submenu: [
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
        ...(config.isDevelopment
          ? ([
              { type: 'separator' },
              { role: 'reload' },
              { role: 'forceReload' },
              { role: 'toggleDevTools' },
            ] satisfies MenuItemConstructorOptions[])
          : []),
      ],
    },
    {
      label: '&Help',
      submenu: [
        {
          label: 'Documentation',
          click: () => {
            void openExternal(DOCS_URL, logger)
          },
        },
        {
          label: 'RecoverX Website',
          click: () => {
            void openExternal(WEBSITE_URL, logger)
          },
        },
      ],
    },
  ]

  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

async function openExternal(url: string, logger: Logger): Promise<void> {
  try {
    await openExternalUrl(url, logger)
  } catch {
    // `openExternalUrl` logs the refusal; a menu click must never surface an
    // unhandled rejection.
  }
}
