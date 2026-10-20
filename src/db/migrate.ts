import type { SQL } from 'bun';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createLogger } from '../utils/logger';

const MIGRATIONS_DIR = join(import.meta.dir, '../../migrations');
const LOCK_ID = 7_260_524_501;

const log = createLogger('Migrate');

/**
 * Applies `migrations/*.sql` in name order, each in its own transaction.
 * An advisory lock keeps concurrent starts from racing.
 */
export async function migrate(sql: SQL, dir = MIGRATIONS_DIR): Promise<void> {
  const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();

  await sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(${LOCK_ID})`;

    await tx`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `;

    const rows = await tx<{ name: string }[]>`
      SELECT name FROM schema_migrations
    `;
    const applied = new Set(rows.map((r) => r.name));

    for (const file of files) {
      if (applied.has(file)) continue;

      const content = await Bun.file(join(dir, file)).text();

      await tx.savepoint(async (sp) => {
        await sp.unsafe(content);
        await sp`INSERT INTO schema_migrations (name) VALUES (${file})`;
      });

      log.info(`applied ${file}`);
    }
  });
}
