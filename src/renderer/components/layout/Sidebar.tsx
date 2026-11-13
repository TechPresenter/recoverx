import { useTranslation } from 'react-i18next'
import { NavLink } from 'react-router-dom'
import {
  HardDrive,
  HeartPulse,
  History,
  Info,
  KeyRound,
  LayoutDashboard,
  LayoutList,
  ScanSearch,
  PanelLeftClose,
  PanelLeftOpen,
  ScrollText,
  Settings,
  type LucideIcon,
} from 'lucide-react'
import { AppRoute, type AppRoutePath } from '@shared/constants/routes'
import type { Translation } from '@/i18n/types'
import { cn } from '@/lib/cn'
import { useUiStore } from '@/stores/ui.store'

/**
 * Every key under `nav` in the locale, derived rather than restated.
 *
 * Listing them by hand meant widening this union on every shipped module, and a
 * forgotten entry surfaced as a confusing type error at the call site rather
 * than as a missing translation.
 */
type NavLabelKey = `nav.${Extract<keyof Translation['nav'], string>}`

interface NavItem {
  readonly to: AppRoutePath
  readonly icon: LucideIcon
  readonly labelKey: NavLabelKey
}

/**
 * Navigation.
 *
 * This list grows one entry per shipped module. It deliberately contains only
 * screens that exist and work — a disabled "coming soon" row in a paid product
 * reads as an unfinished build, not as a roadmap.
 */
const PRIMARY_ITEMS: readonly NavItem[] = [
  { to: AppRoute.Dashboard, icon: LayoutDashboard, labelKey: 'nav.dashboard' },
  { to: AppRoute.Devices, icon: HardDrive, labelKey: 'nav.devices' },
  { to: AppRoute.Scan, icon: ScanSearch, labelKey: 'nav.scan' },
  { to: AppRoute.Partitions, icon: LayoutList, labelKey: 'nav.partitions' },
  { to: AppRoute.Health, icon: HeartPulse, labelKey: 'nav.health' },
  { to: AppRoute.History, icon: History, labelKey: 'nav.history' },
]

const SYSTEM_ITEMS: readonly NavItem[] = [
  { to: AppRoute.License, icon: KeyRound, labelKey: 'nav.license' },
  { to: AppRoute.Settings, icon: Settings, labelKey: 'nav.settings' },
  { to: AppRoute.Logs, icon: ScrollText, labelKey: 'nav.logs' },
  { to: AppRoute.About, icon: Info, labelKey: 'nav.about' },
]

export function Sidebar() {
  const { t } = useTranslation()
  const collapsed = useUiStore((state) => state.sidebarCollapsed)
  const toggle = useUiStore((state) => state.toggleSidebar)

  return (
    <nav
      aria-label={t('nav.sectionMain')}
      style={{
        width: collapsed ? 'var(--rx-sidebar-width-collapsed)' : 'var(--rx-sidebar-width)',
      }}
      className="flex shrink-0 flex-col border-r border-line bg-app-subtle transition-[width] duration-200 ease-out"
    >
      <div className="flex-1 overflow-y-auto overflow-x-hidden px-2.5 py-3">
        <NavSection title={t('nav.sectionMain')} collapsed={collapsed} items={PRIMARY_ITEMS} />
        <NavSection
          title={t('nav.sectionSystem')}
          collapsed={collapsed}
          items={SYSTEM_ITEMS}
          className="mt-5"
        />
      </div>

      <div className="border-t border-line p-2.5">
        <button
          type="button"
          onClick={toggle}
          aria-label={collapsed ? t('nav.expand') : t('nav.collapse')}
          title={collapsed ? t('nav.expand') : t('nav.collapse')}
          className={cn(
            'flex h-9 w-full items-center gap-3 rounded-lg px-2.5 text-ink-subtle transition-colors',
            'hover:bg-surface-2 hover:text-ink',
          )}
        >
          {collapsed ? <PanelLeftOpen size={17} /> : <PanelLeftClose size={17} />}
          {!collapsed && <span className="text-[13px]">{t('nav.collapse')}</span>}
        </button>
      </div>
    </nav>
  )
}

interface NavSectionProps {
  title: string
  items: readonly NavItem[]
  collapsed: boolean
  className?: string
}

function NavSection({ title, items, collapsed, className }: NavSectionProps) {
  const { t } = useTranslation()

  return (
    <div className={className}>
      {/*
        The heading stays in the accessibility tree when collapsed — hiding it
        visually is a layout decision, not a semantic one.
      */}
      <h2
        className={cn(
          'px-2.5 pb-1.5 text-[11px] font-semibold tracking-wider text-ink-subtle uppercase',
          collapsed && 'sr-only',
        )}
      >
        {title}
      </h2>

      <ul className="space-y-0.5">
        {items.map((item) => (
          <li key={item.to}>
            <NavLink
              to={item.to}
              // `end` prevents the dashboard route ("/") matching every path.
              end={item.to === AppRoute.Dashboard}
              title={collapsed ? t(item.labelKey) : undefined}
              className={({ isActive }) =>
                cn(
                  'group relative flex h-9 items-center gap-3 rounded-lg px-2.5 transition-colors',
                  isActive
                    ? 'gradient-accent text-accent-contrast shadow-glow font-medium'
                    : 'text-ink-muted hover:bg-surface-2 hover:text-ink',
                )
              }
            >
              {({ isActive }) => (
                <>
                  {isActive && (
                    <span
                      aria-hidden
                      className="absolute top-1/2 -left-2.5 h-5 w-1 -translate-y-1/2 rounded-r-full bg-accent-alt"
                    />
                  )}
                  <item.icon size={17} className="shrink-0" aria-hidden />
                  {!collapsed && <span className="truncate text-[13.5px]">{t(item.labelKey)}</span>}
                </>
              )}
            </NavLink>
          </li>
        ))}
      </ul>
    </div>
  )
}
