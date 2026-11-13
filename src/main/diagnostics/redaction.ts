import { homedir, userInfo } from 'node:os'

/**
 * Removing the user's identity from diagnostic text.
 *
 * Kept apart from the crash reporter that uses it, for two reasons. It is pure,
 * so it can be tested directly rather than through a class that needs Electron
 * running. And it is the privacy boundary of this whole feature, which is worth
 * being able to read on its own.
 */

export type Redactor = (text: string) => string

/**
 * Build the redaction function for this machine.
 *
 * Two things are removed, and both are here because a stack trace from a
 * desktop application leaks them by default.
 *
 * The home directory appears in the path of every bundled file, and it contains
 * the user's account name — frequently their real name. The account name is
 * also removed on its own, because it shows up in temporary paths that do not
 * sit under the home directory.
 *
 * The replacements are deliberately readable rather than blanked out: a support
 * engineer still needs to see the shape of a path to make sense of a trace.
 */
export function createRedactor(home = safeHomedir(), username = safeUsername()): Redactor {
  const rules: Array<{ readonly pattern: RegExp; readonly replacement: string }> = []

  if (home.length > 0) {
    rules.push({ pattern: new RegExp(escapeRegExp(home), 'giu'), replacement: '<home>' })

    // Windows paths reach a stack trace through both separators depending on
    // whether Node or Chromium produced them.
    const alternate = home.includes('\\') ? home.replace(/\\/gu, '/') : home.replace(/\//gu, '\\')
    if (alternate !== home) {
      rules.push({ pattern: new RegExp(escapeRegExp(alternate), 'giu'), replacement: '<home>' })
    }
  }

  if (username.length > 2) {
    // Bounded by non-word characters so a username that is a common substring —
    // "sam" inside "same" — does not shred unrelated text.
    rules.push({
      pattern: new RegExp(`(?<![A-Za-z0-9])${escapeRegExp(username)}(?![A-Za-z0-9])`, 'giu'),
      replacement: '<user>',
    })
  }

  return (text: string): string => {
    let result = text
    for (const rule of rules) result = result.replace(rule.pattern, rule.replacement)

    return result
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
}

function safeHomedir(): string {
  try {
    return homedir()
  } catch {
    return ''
  }
}

function safeUsername(): string {
  try {
    return userInfo().username
  } catch {
    return ''
  }
}
