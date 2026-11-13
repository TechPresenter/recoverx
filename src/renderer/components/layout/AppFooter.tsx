import { useTranslation } from 'react-i18next'
import { COPYRIGHT_NOTICE, VENDOR_NAME, VENDOR_URL } from '@shared/constants/app'
import { IpcChannel } from '@shared/ipc/channels'
import { invoke } from '@/lib/ipc-client'

/**
 * Vendor attribution, on every screen.
 *
 * Deliberately quiet: one line, subtle type, no border heavier than the rest of
 * the chrome. A footer on a tool people use while their data is missing should
 * be findable, not competing with the thing they came to do. The full notice
 * and the licence terms live on the About screen, where someone looking for
 * them will actually be.
 *
 * The link opens through the main process rather than as an anchor, so it goes
 * through the navigation guard that restricts which hosts this application may
 * hand to the operating system.
 */
export function AppFooter() {
  const { t } = useTranslation()

  return (
    <footer className="border-t border-line/70 px-7 py-2.5">
      <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11.5px] text-ink-subtle">
        <span>{t('about.builtBy', { vendor: VENDOR_NAME })}</span>

        <Separator />

        <button
          type="button"
          onClick={() => {
            void invoke(IpcChannel.AppOpenExternal, { url: VENDOR_URL })
          }}
          className="rounded-sm underline-offset-2 transition-colors hover:text-accent hover:underline"
        >
          {VENDOR_URL.replace('https://', '')}
        </button>

        <Separator />

        <span>{COPYRIGHT_NOTICE}</span>
      </p>
    </footer>
  )
}

function Separator() {
  return (
    <span aria-hidden className="text-line-strong">
      |
    </span>
  )
}
