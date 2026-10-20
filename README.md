# scheduler-engine

A small, durable job scheduler for personal automation, built on Bun and
Postgres.

- **Flow definitions in code**: typed slots (provider clients), zod-validated
  config and payload, durable `step()`s.
- **Flow instances in the database**: one definition can run as many
  instances, each with its own schedule, config and accounts, managed at
  runtime over an HTTP admin API.
- **Durable execution**: completed steps are memoized, so retries and crash
  recovery resume where a run left off. Runs are claimed with
  `FOR UPDATE SKIP LOCKED`, heartbeated, and requeued if a worker dies.
- **Schedules**: minute/hour/day/week/month/year rules with intervals,
  expected values, exclusions (incl. US holidays), start/end, time zones.
- **Dependencies**: a flow can wait for its parent flow's latest run (within a
  freshness window) and is failed if the parent fails.
- **Providers**: Google (Gmail, Sheets, Drive) with OAuth; add your own via
  module augmentation.

## Install

Bun runs the TypeScript sources directly, no build step:

```sh
bun add github:limisc/scheduler-engine#v0.1.0
```

## Usage

```ts
import { SQL } from 'bun';
import { z } from 'zod';
import { createApp, createGoogle, defineFlow } from '@limisc/scheduler-engine';

const gmailCleanup = defineFlow({
  name: 'gmail-cleanup',
  description: 'Archive or trash threads matching a query',
  slots: { google: { provider: 'google' } },
  config: z.object({
    query: z.string(),
    action: z.enum(['archive', 'trash']).default('archive'),
  }),
  async run({ step, clients, config }) {
    const threads = await step('search', () =>
      clients.google.gmail.search(config.query),
    );
    await step(config.action, () => clients.google.gmail[config.action](threads));
    return { count: threads.length };
  },
});

const app = createApp({
  sql: new SQL(Bun.env.DATABASE_URL!),
  encryptionKey: Bun.env.ENCRYPTION_KEY!, // openssl rand -base64 32
  defs: [gmailCleanup],
  providers: {
    google: createGoogle({
      clientId: Bun.env.GOOGLE_CLIENT_ID!,
      clientSecret: Bun.env.GOOGLE_CLIENT_SECRET!,
      redirectUri: 'https://example.com/auth/google/callback',
    }),
  },
  zone: 'America/Denver',
  server: { port: 3000, adminToken: Bun.env.ADMIN_TOKEN },
});

await app.start();
```

### Steps

`step(name, fn)` persists `fn`'s JSON result. When a run is retried (or
recovered after a crash) completed steps return their stored result instead of
running again, so put side effects in their own steps and keep them
idempotent: a step that was interrupted mid-way runs again.

### Errors and retries

A run is retried with exponential backoff up to `retries` times (default 2).
Throw `FatalError` to fail immediately. HTTP 4xx responses (except 408/429)
are treated as fatal.

## Admin API

All routes except `/health` and the OAuth callback need
`Authorization: Bearer $ADMIN_TOKEN`.

| Method | Path | |
| --- | --- | --- |
| GET | `/health` | liveness |
| GET | `/auth/:provider?name=&token=` | start OAuth, connect account `name` |
| GET | `/defs` | registered definitions (slots, config/payload JSON schema) |
| GET, POST | `/flows` | list / create instances |
| GET, PATCH, DELETE | `/flows/:name` | inspect (bindings, upcoming, recent runs) / update / remove |
| PUT, DELETE | `/flows/:name/bindings/:slot` | `{ "account": "personal" }` |
| POST | `/flows/:name/run` | trigger with JSON payload |
| GET | `/accounts` | accounts (no secrets) |
| PUT, DELETE | `/accounts/:provider/:name` | `{ "credential": "...", "config": {} }` for non-OAuth providers |
| GET | `/runs?flow=&status=&limit=&before=` | recent runs |
| GET | `/runs/:id` | run with steps |
| POST | `/runs/:id/retry` | requeue a failed run |

Create and enable an instance:

```sh
curl -X POST "$URL/flows" -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H 'Content-Type: application/json' -d '{
    "name": "gmail-cleanup.personal",
    "def": "gmail-cleanup",
    "config": { "query": "category:promotions older_than:7d" },
    "schedules": [{ "fre": "day", "expects": { "hour": [6] } }],
    "bindings": { "google": "personal" },
    "enabled": true
  }'
```

### Schedules

```jsonc
{ "fre": "minute", "interval": 15 }
{ "fre": "day", "expects": { "hour": [7, 18], "minute": [30] } }
{ "fre": "week", "expects": { "weekday": [1, 2, 3, 4, 5], "hour": [6] }, "excludes": { "holidays": true } }
{ "fre": "month", "expects": { "day": [1, 15], "hour": [9] }, "zone": "America/New_York" }
{ "fre": "day", "interval": 2, "start": "2026-01-01", "end": "2026-12-31" }
```

Weekday `1` is Monday. Without `zone`, the app's `zone` is used. After
downtime only the latest missed occurrence runs, unless the definition sets
`catchUp: 'all'`.

### Dependencies

Set `parent` (and optionally `freshness_seconds`) on an instance. Its runs
wait for the parent's latest run scheduled at or before them; they start when
it completes and fail when it fails or when no (fresh enough) parent run
exists.

## Custom providers

```ts
declare module '@limisc/scheduler-engine' {
  interface Clients {
    acme: AcmeClient;
  }
}

createApp({ providers: { acme: { createClient: (account) => createAcme(account.credential) } } });
```

## Development

```sh
bun install
bun run check
DATABASE_URL_TEST=postgres://postgres@localhost:5432/postgres bun test
```
