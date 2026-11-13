import { isIPv4, isIPv6 } from 'node:net'

/**
 * Per-client token-bucket rate limiting for the public endpoints.
 *
 * The threat it answers is not a denial of service — a reverse proxy or the
 * hosting platform is the place for that — but enumeration: walking the key
 * space looking for a key that activates. The key body carries 95 random bits,
 * so that is hopeless anyway, but bounding the attempt rate also bounds the
 * load such a script can put on the database and the noise it puts in the log.
 *
 * A token bucket rather than a fixed window, because legitimate traffic is
 * bursty: an office that has just bought a Business licence activates three
 * machines within the same minute from the same NAT address, and should not
 * be told to wait. The burst absorbs that; the refill rate bounds the rest.
 *
 * State is in memory and per process. Running several replicas multiplies the
 * effective limit by the replica count, which is acceptable for this purpose.
 */

export interface RateLimitOptions {
  /** Requests a client may make back to back. */
  readonly burst: number
  /** Sustained requests per minute once the burst is spent. */
  readonly perMinute: number
  /** Clients tracked before idle ones are evicted. Bounds memory. */
  readonly maxClients?: number
  readonly clock?: () => number
}

export type RateDecision =
  { readonly allowed: true } | { readonly allowed: false; readonly retryAfterSeconds: number }

interface Bucket {
  tokens: number
  updatedAt: number
}

const DEFAULT_MAX_CLIENTS = 50_000

export class RateLimiter {
  private readonly burst: number
  private readonly refillPerMs: number
  private readonly maxClients: number
  private readonly clock: () => number
  private readonly buckets = new Map<string, Bucket>()

  constructor(options: RateLimitOptions) {
    this.burst = Math.max(1, options.burst)
    this.refillPerMs = Math.max(1, options.perMinute) / 60_000
    this.maxClients = options.maxClients ?? DEFAULT_MAX_CLIENTS
    this.clock = options.clock ?? Date.now
  }

  /**
   * Spend one token for `client`, or say how long until one is available.
   *
   * `scope` keeps unrelated limits apart in one table: failed admin logins are
   * counted separately from activations made from the same address.
   */
  take(client: string, scope = 'public'): RateDecision {
    const now = this.clock()
    const id = `${scope}|${clientBucketId(client)}`
    const existing = this.buckets.get(id)

    // Room is made before a new client is added, never after: evicting
    // afterwards could drop the very bucket about to be charged, handing a new
    // client a fresh burst on every request once the table is full.
    if (existing === undefined && this.buckets.size >= this.maxClients) this.evict(now)

    const bucket = existing ?? { tokens: this.burst, updatedAt: now }

    const elapsed = Math.max(0, now - bucket.updatedAt)
    bucket.tokens = Math.min(this.burst, bucket.tokens + elapsed * this.refillPerMs)
    bucket.updatedAt = now

    // Re-inserting moves the client to the back of the Map's insertion order,
    // which makes the second pass of `evict` least-recently-used.
    this.buckets.delete(id)
    this.buckets.set(id, bucket)

    if (bucket.tokens >= 1) {
      bucket.tokens -= 1
      return { allowed: true }
    }

    const waitMs = (1 - bucket.tokens) / this.refillPerMs
    return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil(waitMs / 1000)) }
  }

  /** Clients currently tracked. Exposed for tests. */
  get size(): number {
    return this.buckets.size
  }

  /**
   * Drop clients whose bucket has refilled completely — they are
   * indistinguishable from a client never seen — and then, if that was not
   * enough, the least recently seen.
   */
  private evict(now: number): void {
    for (const [id, bucket] of this.buckets) {
      const refilled = bucket.tokens + (now - bucket.updatedAt) * this.refillPerMs
      if (refilled >= this.burst) this.buckets.delete(id)
    }

    for (const id of this.buckets.keys()) {
      if (this.buckets.size < this.maxClients) break
      this.buckets.delete(id)
    }
  }
}

/**
 * The identity a client is rate limited under.
 *
 * IPv4 addresses are used as they are. IPv6 addresses are reduced to their /64
 * prefix: a single subscriber is routinely given a whole /64, and limiting per
 * address would hand one client 2^64 separate buckets.
 */
export function clientBucketId(address: string): string {
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/iu.exec(address)
  if (mapped?.[1] !== undefined) return mapped[1]

  if (isIPv4(address)) return address
  if (!isIPv6(address)) return address

  const groups = expandIPv6(address.split('%')[0] ?? address)
  return groups === null ? address : `${groups.slice(0, 4).join(':')}::/64`
}

/** Expand `::` shorthand into eight hextets, or `null` if the form is unexpected. */
function expandIPv6(address: string): string[] | null {
  const halves = address.toLowerCase().split('::')
  if (halves.length > 2) return null

  const head = halves[0] === undefined || halves[0] === '' ? [] : halves[0].split(':')
  const tail =
    halves.length === 2 && halves[1] !== undefined && halves[1] !== '' ? halves[1].split(':') : []

  // An embedded IPv4 tail occupies two hextets; the prefix never includes it.
  const tailWidth = tail.reduce((width, part) => width + (part.includes('.') ? 2 : 1), 0)
  const missing = 8 - head.length - tailWidth

  if (halves.length === 1 && missing !== 0) return null
  if (missing < 0) return null

  const groups = [...head, ...Array<string>(missing).fill('0'), ...tail]
  return groups.map((group) => (group.includes('.') ? group : group.replace(/^0+(?=.)/u, '')))
}
