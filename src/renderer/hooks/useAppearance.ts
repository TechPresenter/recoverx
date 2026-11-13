import { useEffect, useState } from 'react'
import { IpcEvent } from '@shared/ipc/channels'
import type { AppSettings, ThemeMode } from '@shared/types/settings'
import { subscribe } from '@/lib/ipc-client'

/**
 * Applies the user's appearance settings to the document root.
 *
 * Theme is a class on `<html>` rather than React state threaded through a
 * provider: switching it is then a single DOM mutation with no re-render, which
 * is what keeps the change instantaneous and flash-free even on the Logs screen
 * with thousands of virtualised rows mounted.
 */
export function useAppearance(settings: AppSettings | null): void {
  const systemPrefersDark = useSystemDarkMode()

  useEffect(() => {
    if (settings === null) return

    const root = document.documentElement
    const isDark = resolveDarkMode(settings.theme, systemPrefersDark)

    root.classList.toggle('dark', isDark)
    root.dataset.accent = settings.accent
    root.classList.toggle('reduce-motion', settings.reduceMotion)
    root.classList.toggle('density-compact', settings.compactDensity)
    root.lang = settings.language
  }, [settings, systemPrefersDark])
}

/** `true` when the effective theme is dark. */
export function useIsDarkMode(theme: ThemeMode): boolean {
  const systemPrefersDark = useSystemDarkMode()
  return resolveDarkMode(theme, systemPrefersDark)
}

/**
 * Track the OS colour-scheme preference.
 *
 * Two sources are used together. `matchMedia` reacts immediately inside the
 * renderer, and the main process broadcast covers the case where Chromium has
 * not yet propagated a Windows theme change to the media query — without the
 * second source, switching Windows to dark mode can leave the app light until
 * the next window focus.
 */
export function useSystemDarkMode(): boolean {
  const [prefersDark, setPrefersDark] = useState(
    () => window.matchMedia('(prefers-color-scheme: dark)').matches,
  )

  useEffect(() => {
    const query = window.matchMedia('(prefers-color-scheme: dark)')

    const onQueryChange = (event: MediaQueryListEvent): void => {
      setPrefersDark(event.matches)
    }

    query.addEventListener('change', onQueryChange)

    const unsubscribe = subscribe(IpcEvent.SystemThemeChanged, (payload) => {
      setPrefersDark(payload.shouldUseDarkColors)
    })

    return () => {
      query.removeEventListener('change', onQueryChange)
      unsubscribe()
    }
  }, [])

  return prefersDark
}

function resolveDarkMode(theme: ThemeMode, systemPrefersDark: boolean): boolean {
  switch (theme) {
    case 'dark':
      return true
    case 'light':
      return false
    case 'system':
      return systemPrefersDark
  }
}
