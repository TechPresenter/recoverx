/**
 * Renderer route table.
 *
 * Declared in the shared kernel (rather than inside the router) because the main
 * process needs to deep-link into specific screens — for example, focusing the
 * window on Settings from the tray menu, or jumping to Logs after a crash report
 * is written.
 */
export const AppRoute = {
  Dashboard: '/',
  Devices: '/devices',
  Scan: '/scan',
  Partitions: '/partitions',
  Health: '/health',
  History: '/history',
  License: '/license',
  Settings: '/settings',
  Logs: '/logs',
  About: '/about',
} as const

export type AppRoutePath = (typeof AppRoute)[keyof typeof AppRoute]

/** Every route that currently exists, in sidebar display order. */
export const APP_ROUTE_ORDER: readonly AppRoutePath[] = [
  AppRoute.Dashboard,
  AppRoute.Devices,
  AppRoute.Scan,
  AppRoute.Partitions,
  AppRoute.Health,
  AppRoute.History,
  AppRoute.License,
  AppRoute.Settings,
  AppRoute.Logs,
  AppRoute.About,
]

/** Type guard used when validating a deep-link target received over IPC. */
export function isAppRoutePath(value: string): value is AppRoutePath {
  return (APP_ROUTE_ORDER as readonly string[]).includes(value)
}
