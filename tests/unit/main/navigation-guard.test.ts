import { describe, expect, it, vi } from 'vitest'
import { parseAllowedExternalUrl } from '@main/security/navigation-guard'
import {
  ALLOWED_EXTERNAL_HOSTS,
  DOCS_URL,
  PRIVACY_URL,
  PURCHASE_URL,
  RELEASE_NOTES_URL,
  VENDOR_URL,
  WEBSITE_URL,
} from '@shared/constants/app'

/**
 * Which links the application may hand to the user's browser.
 *
 * Electron cannot load in a plain Node process. The guard's module only needs
 * the names to exist at import time, and nothing here reaches them.
 */
vi.mock('electron', () => ({ shell: {}, protocol: {}, session: {} }))

describe('the external link allowlist', () => {
  it('names only hosts the vendor controls', () => {
    // Every installed copy keeps this list for life. A domain someone else
    // owns could serve those copies anything, under the product's name — so a
    // change here is a decision, and this test makes it a visible one.
    expect([...ALLOWED_EXTERNAL_HOSTS].sort()).toEqual([
      'appsgain.in',
      'recoverx.snapkio.com',
      'www.appsgain.in',
    ])
  })

  it('lets every link the application itself emits through', () => {
    // A link the guard refuses is a button that does nothing: the Buy button
    // above all, where silence reads as a product that does not want to be
    // bought.
    for (const url of [
      WEBSITE_URL,
      DOCS_URL,
      PRIVACY_URL,
      RELEASE_NOTES_URL,
      PURCHASE_URL,
      VENDOR_URL,
    ]) {
      expect(parseAllowedExternalUrl(url), url).not.toBeNull()
    }
  })

  it('refuses any other host', () => {
    expect(parseAllowedExternalUrl('https://example.com/')).toBeNull()
    expect(parseAllowedExternalUrl('https://github.com/')).toBeNull()
  })

  it('matches a host exactly, never as a prefix or a suffix', () => {
    expect(parseAllowedExternalUrl('https://recoverx.snapkio.com.example.test/')).toBeNull()
    expect(parseAllowedExternalUrl('https://evil.recoverx.snapkio.com/')).toBeNull()
  })

  it('refuses plain HTTP and URLs carrying credentials', () => {
    expect(parseAllowedExternalUrl('http://recoverx.snapkio.com/buy/')).toBeNull()
    expect(parseAllowedExternalUrl('https://customer@recoverx.snapkio.com/')).toBeNull()
  })
})
