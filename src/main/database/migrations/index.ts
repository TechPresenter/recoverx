import type { Migration } from '../migration-plan'
import { migration001 } from './001-initial-schema'
import { migration002 } from './002-scan-results'
import { migration003 } from './003-recovery-jobs'
import { migration004 } from './004-health-history'
import { migration005 } from './005-recovery-allowance'

/**
 * The ordered migration registry.
 *
 * Rules, enforced by `assertValidMigrationList` at startup:
 *   - versions are contiguous and start at 1;
 *   - a migration that has shipped is never edited — write a new one instead;
 *   - each migration is applied inside a transaction, so a failure leaves the
 *     database at its previous version rather than half-upgraded.
 */
export const MIGRATIONS: readonly Migration[] = [
  migration001,
  migration002,
  migration003,
  migration004,
  migration005,
]
