import { DOCS_URL, SUPPORT_EMAIL } from '@shared/constants/app'
import type { KeyProblem } from '@shared/utils/license-key'

/**
 * Every sentence the licence server says to a customer.
 *
 * The desktop application shows the `error` field of a refused activation
 * verbatim, so each of these is product copy, not a log message. They are kept
 * in one file for that reason: a reviewer can read every customer-visible
 * string in one place, and none of them is assembled from fragments scattered
 * through the request handling.
 *
 * The rules they follow:
 *
 *  - Say what happened in the customer's terms, then what to do about it. "403"
 *    and "seat" are vendor vocabulary; "already active on another computer" is
 *    not.
 *  - Never blame the customer for something the server cannot know they did.
 *    An unknown key is far more often a typo or a not-yet-provisioned order than
 *    an attempt at piracy.
 *  - Always leave a way forward — a support address, a renewal page, or the
 *    instruction to update the application when the request itself is the
 *    problem.
 */

const SUPPORT = SUPPORT_EMAIL

export const CustomerMessages = {
  // --- Request shape --------------------------------------------------------
  // These are reached only by an out-of-date or broken client, never by a
  // customer typing something, so they point at updating the application.
  incompleteRequest: 'The activation request was incomplete. Update RecoverX and try again.',
  unreadableRequest: 'The activation request could not be read. Update RecoverX and try again.',
  wrongContentType: 'The activation request was sent in a format this server does not accept.',
  bodyTooLarge: 'The request was too large for this server to accept.',
  wrongProduct:
    'This licence server activates RecoverX only. Check that you are activating the right product.',
  invalidMachine:
    'RecoverX sent a computer identifier this server does not recognise. Update RecoverX and try again.',

  // --- The licence key itself ----------------------------------------------
  keyEmpty: 'Enter your licence key.',
  keyWrongProduct: 'That licence key is for a different product. RecoverX keys start with RECX.',
  keyWrongLength:
    'That licence key is the wrong length. A RecoverX key has 20 characters after the RECX prefix.',
  keyBadCharacter:
    'That licence key contains characters a RecoverX key never uses. Check it against your receipt.',
  keyChecksum: 'That licence key has a typing error in it. Check it against your receipt.',

  // --- The licence's standing ----------------------------------------------
  unknownKey: `We could not find that licence key. Check it against your receipt, or contact ${SUPPORT} if it came with a recent order.`,
  revoked: `This licence key is no longer valid. If you think this is a mistake, contact ${SUPPORT}.`,
  // Every edition has every feature — a paid one only lifts the Free edition's
  // 1 GB limit — so there are no "paid features" to keep. Renewing is done by
  // e-mail, as the website's support page explains; the website sells nothing.
  expired: (endedOn: string): string =>
    `This licence ended on ${endedOn}. Renew it by emailing ${SUPPORT} (see ${DOCS_URL}#renew) to recover without limit again.`,
  seatsExhausted: (activeOn: number): string =>
    `This licence is already active on ${activeOn === 1 ? 'another computer' : `${activeOn} computers`}, which is all it allows. ` +
    `Deactivate RecoverX on a computer you no longer use, or contact ${SUPPORT} and we will move the licence for you.`,

  // --- Deactivation ---------------------------------------------------------
  tokenUnreadable: 'That activation could not be read, so no licence seat was released.',
  tokenForged:
    'That activation was not issued by the RecoverX licence server, so no licence seat was released.',
  tokenLicenceMissing: `We could not find the licence this activation belongs to. Contact ${SUPPORT} and we will release it for you.`,
  // The two refusals below leave the licence where it is, and the desktop
  // client keeps it, so each says so: a customer who reads only "refused"
  // would assume the computer they are sitting at has just lost its licence.
  selfReleaseLimit: (moves: number, windowDays: number): string =>
    `This licence has already been moved between computers ${timesCount(moves)} in ${describeWindow(windowDays)}. ` +
    `It is still active on this computer. To move it again, contact ${SUPPORT} with your licence key.`,
  selfReleaseDisabled:
    'This licence can only be moved to another computer by our support team. ' +
    `It is still active on this computer. To move it, contact ${SUPPORT} with your licence key.`,

  // --- Transport ------------------------------------------------------------
  rateLimited:
    'Too many activation attempts have come from your network. Wait a minute, then try again.',
  notFound: 'There is nothing at this address on the RecoverX licence server.',
  methodNotAllowed: 'This address does not accept that kind of request.',
  busy: 'The licence server is busy. Please try again in a few seconds.',
  internal: `Something went wrong on our side. Please try again in a few minutes, or contact ${SUPPORT} if it keeps happening.`,
  unauthorized: 'This request needs a valid administrator token.',
} as const

/** The sentence for a key that failed its local shape and checksum test. */
export function describeKeyProblem(problem: KeyProblem | null): string {
  switch (problem) {
    case null:
    case 'checksum':
      return CustomerMessages.keyChecksum
    case 'empty':
      return CustomerMessages.keyEmpty
    case 'wrong-product':
      return CustomerMessages.keyWrongProduct
    case 'wrong-length':
      return CustomerMessages.keyWrongLength
    case 'bad-character':
      return CustomerMessages.keyBadCharacter
  }
}

/** `once`, `twice`, `3 times` — how a person says a count of occasions. */
function timesCount(count: number): string {
  if (count === 1) return 'once'
  if (count === 2) return 'twice'
  return `${count} times`
}

/**
 * A rolling window in the customer's terms.
 *
 * Whole years are said in months, because "the last 12 months" is how people
 * describe a rolling year; "the last year" reads as the previous calendar
 * year, which is not what is being counted.
 */
function describeWindow(days: number): string {
  if (days % 365 === 0) return `the last ${(days / 365) * 12} months`
  return days === 1 ? 'the last day' : `the last ${days} days`
}

const DATE_FORMAT = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric',
  month: 'long',
  year: 'numeric',
  timeZone: 'UTC',
})

/**
 * A date a customer can read without converting it, e.g. `12 March 2027`.
 *
 * Spelled out rather than numeric because `03/12/2027` means two different
 * days depending on which side of the Atlantic the customer is on, and an
 * expiry notice is exactly the sentence that must not be ambiguous. UTC is used
 * because that is the zone the server's expiry instants are computed in.
 */
export function formatCustomerDate(epochMs: number): string {
  return DATE_FORMAT.format(new Date(epochMs))
}
