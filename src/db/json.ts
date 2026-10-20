import type { SQL } from 'bun';

/**
 * A jsonb value for any JSON-serializable input. Bun binds JS numbers and
 * booleans as numeric/boolean parameters, which Postgres won't coerce to
 * jsonb, so the value is sent as text and cast.
 */
export function jsonb(sql: SQL, value: unknown) {
  if (value === undefined) return sql`NULL`;
  return sql`${JSON.stringify(value)}::text::jsonb`;
}
