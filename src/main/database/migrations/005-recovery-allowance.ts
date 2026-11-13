import type { Migration } from '../migration-plan'

/**
 * A running total of everything ever recovered on this computer, kept apart
 * from the recovery history.
 *
 * The Free edition's allowance is "1 GB of recovered files in total on each
 * computer". Charging it from the sum over `recovery_job` does not hold that
 * promise, because the history is the user's to tidy: History → Delete record
 * removes a job, and deleting a scan removes its jobs with it. Each deletion
 * would hand the allowance back, and recovering 1 GB, deleting the record and
 * recovering again would be unlimited free recovery. The ledger only ever
 * grows, and nothing in the application deletes from it.
 *
 * What it cannot stop is someone deleting the database file itself, the same
 * boundary the licence file has: whatever is stored on a computer, its owner
 * can remove. The point is that no button in the application gives the
 * allowance back.
 *
 * One row, so there is nothing to sum and no row to lose. It starts at what the
 * history already holds, so a database from before the ledger is charged for
 * what it had recovered.
 */
export const migration005: Migration = {
  version: 5,
  name: 'recovery-allowance',
  up: (db) => {
    db.exec(`
      CREATE TABLE recovery_allowance (
        id              INTEGER NOT NULL PRIMARY KEY CHECK (id = 1),
        recovered_bytes INTEGER NOT NULL DEFAULT 0 CHECK (recovered_bytes >= 0)
      );
    `)

    db.exec(`
      INSERT INTO recovery_allowance (id, recovered_bytes)
        SELECT 1, COALESCE(SUM(recovered_bytes), 0) FROM recovery_job;
    `)
  },
}
