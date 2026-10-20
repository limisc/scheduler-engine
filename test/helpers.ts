import { SQL } from 'bun';
import { randomBytes } from 'node:crypto';
import { migrate } from '../src/db/migrate';

export const DATABASE_URL_TEST = Bun.env.DATABASE_URL_TEST;

export const ENCRYPTION_KEY = randomBytes(32).toString('base64');

/** Creates a throwaway database with migrations applied. */
export async function createTestDatabase() {
  if (!DATABASE_URL_TEST) throw new Error('DATABASE_URL_TEST is not set');

  const admin = new SQL(DATABASE_URL_TEST);
  const name = `scheduler_test_${randomBytes(6).toString('hex')}`;
  await admin.unsafe(`CREATE DATABASE ${name}`);

  const url = new URL(DATABASE_URL_TEST);
  url.pathname = `/${name}`;

  const sql = new SQL(url.toString());
  await migrate(sql);

  return {
    sql,

    async reset(): Promise<void> {
      await sql`TRUNCATE accounts, flows, bindings, runs, steps CASCADE`;
    },

    async drop(): Promise<void> {
      await sql.close();
      await admin.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await admin.close();
    },
  };
}

export async function waitFor<T>(
  fn: () => Promise<T | null | undefined | false>,
  timeout = 5_000,
): Promise<T> {
  const until = Date.now() + timeout;

  while (Date.now() < until) {
    const value = await fn();
    if (value) return value;
    await Bun.sleep(25);
  }

  throw new Error('waitFor timed out');
}
