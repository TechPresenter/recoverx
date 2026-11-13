/* eslint-disable react-refresh/only-export-components --
 * This module's export is the router, not a component. The `lazy()` bindings
 * below are route definitions that the rule mistakes for component exports;
 * splitting them out would separate each route from the table that uses it for
 * no benefit, since editing this file legitimately requires a full reload.
 */
import { lazy } from 'react'
import { createHashRouter, Navigate } from 'react-router-dom'
import { AppRoute } from '@shared/constants/routes'
import { AppShell } from '@/components/layout/AppShell'

/**
 * Route table.
 *
 * A hash router is used deliberately. The packaged renderer is served from a
 * custom `app://` scheme with no server behind it, so a history-based router
 * would 404 on reload or deep-link — there is nothing to rewrite unknown paths
 * to `index.html`. Hash routing sidesteps that entirely, and the URL is never
 * visible to the user in a frameless window.
 *
 * Every screen is code-split. Only the shell and the dashboard are needed for
 * first paint; Settings, Logs and About load on demand, which keeps the initial
 * chunk small and the start-up budget intact.
 */

const DashboardPage = lazy(async () => ({
  default: (await import('@/features/dashboard/DashboardPage')).DashboardPage,
}))

const DevicesPage = lazy(async () => ({
  default: (await import('@/features/devices/DevicesPage')).DevicesPage,
}))

const ScanPage = lazy(async () => ({
  default: (await import('@/features/scan/ScanPage')).ScanPage,
}))

const PartitionsPage = lazy(async () => ({
  default: (await import('@/features/partitions/PartitionsPage')).PartitionsPage,
}))

const HealthPage = lazy(async () => ({
  default: (await import('@/features/health/HealthPage')).HealthPage,
}))

const HistoryPage = lazy(async () => ({
  default: (await import('@/features/history/HistoryPage')).HistoryPage,
}))

const LicensePage = lazy(async () => ({
  default: (await import('@/features/license/LicensePage')).LicensePage,
}))

const SettingsPage = lazy(async () => ({
  default: (await import('@/features/settings/SettingsPage')).SettingsPage,
}))

const LogsPage = lazy(async () => ({
  default: (await import('@/features/logs/LogsPage')).LogsPage,
}))

const AboutPage = lazy(async () => ({
  default: (await import('@/features/about/AboutPage')).AboutPage,
}))

export const router = createHashRouter([
  {
    path: '/',
    element: <AppShell />,
    children: [
      { index: true, element: <DashboardPage /> },
      { path: AppRoute.Devices.slice(1), element: <DevicesPage /> },
      { path: AppRoute.Scan.slice(1), element: <ScanPage /> },
      { path: AppRoute.Partitions.slice(1), element: <PartitionsPage /> },
      { path: AppRoute.Health.slice(1), element: <HealthPage /> },
      { path: AppRoute.History.slice(1), element: <HistoryPage /> },
      { path: AppRoute.License.slice(1), element: <LicensePage /> },
      { path: AppRoute.Settings.slice(1), element: <SettingsPage /> },
      { path: AppRoute.Logs.slice(1), element: <LogsPage /> },
      { path: AppRoute.About.slice(1), element: <AboutPage /> },
      // An unknown hash can only come from a stale deep link; sending the user
      // to the dashboard is friendlier than a dead-end error screen.
      { path: '*', element: <Navigate to={AppRoute.Dashboard} replace /> },
    ],
  },
])
