# scheduler-engine

Public engine for a personal durable scheduler. Flow **definitions** live in
code (`defineFlow`), flow **instances** (schedule, config, account bindings,
parent dependency) live in Postgres and are managed through the admin facade
(`src/app/admin.ts`), exposed over HTTP (`src/app/server.ts`).

## Layout

- `src/app/` – wiring: `app.ts` (createApp), `engine.ts` (worker adapter:
  claim → run → complete/retry/fail), `scheduler.ts` (tick: plan due flows,
  reap stale runs, prune), `admin.ts`, `server.ts`
- `src/runtime/` – generic signal / ticker / worker primitives
- `src/modules/<name>/` – `*.types.ts`, `*.store.ts` (raw SQL), `*.service.ts`
  (rules + transactions), `*.registry.ts`, `*.validator.ts`
- `src/modules/client/provider/<provider>/` – provider clients (Google, …)
- `migrations/*.sql` – applied in order by `src/db/migrate.ts` at startup

## Conventions

- Factory functions, not classes: `export function createX(deps) { …; return { … }; }`
  and `export type X = ReturnType<typeof createX>`. Classes only for errors.
- Single quotes, semicolons, trailing commas, 80 columns (Biome enforces).
- snake_case for DB row fields, camelCase elsewhere. `import type` for types.
- Errors: `FatalError` (no retry), `ValidationError` (HTTP 400),
  `NotFoundError` (HTTP 404). `HttpError` 4xx (not 408/429) is fatal too.
- jsonb writes of arbitrary values go through `jsonb()` in `src/db/json.ts`
  (Bun binds numbers/booleans with non-json types).
- Never edit an applied migration; add `migrations/00N_*.sql`.

## Commands

- `bun run check` – biome + tsc
- `bun test` – unit tests; DB tests need `DATABASE_URL_TEST` (a database the
  user can `CREATE DATABASE` from; each test file creates and drops its own)

Default to Bun APIs: `Bun.serve`, `Bun.SQL`, `bun:test`, `Bun.file`. Bun loads
`.env` automatically, don't use dotenv.
