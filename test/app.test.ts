import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { createApp, type App } from '../src/app/app';
import type { RunEvent } from '../src/app/engine';
import { defineFlow } from '../src/modules/flow/flow.registry';
import { FatalError } from '../src/utils/error';
import {
  createTestDatabase,
  DATABASE_URL_TEST,
  ENCRYPTION_KEY,
  waitFor,
} from './helpers';

const TOKEN = 'test-admin-token';

const read = async (res: Response | Promise<Response>): Promise<any> =>
  (await res).json();
const calls = { a: 0, b: 0 };

const flaky = defineFlow({
  name: 'flaky',
  retries: 2,
  async run({ step }) {
    const a = await step('a', () => ++calls.a);
    await step('b', () => {
      if (++calls.b === 1) throw new Error('transient');
    });
    return { a };
  },
});

const fatal = defineFlow({
  name: 'fatal',
  async run() {
    throw new FatalError('do not retry');
  },
});

const greet = defineFlow({
  name: 'greet',
  slots: { google: { provider: 'google' } },
  config: z.object({ greeting: z.string() }),
  payload: z.object({ who: z.string().default('world') }),
  async run({ step, clients, config, payload }) {
    return step('greet', () => ({
      text: `${config.greeting} ${payload.who}`,
      account: (clients.google as unknown as { name: string }).name,
    }));
  },
});

describe.skipIf(!DATABASE_URL_TEST)('app', () => {
  let db: Awaited<ReturnType<typeof createTestDatabase>>;
  let app: App;
  let base: string;
  const failed: (RunEvent & { error: string })[] = [];

  const api = (path: string, init: RequestInit = {}) =>
    fetch(`${base}${path}`, {
      ...init,
      headers: { Authorization: `Bearer ${TOKEN}`, ...init.headers },
    });

  const json = (method: string, path: string, body?: unknown) =>
    api(path, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

  beforeAll(async () => {
    db = await createTestDatabase();
    app = createApp({
      sql: db.sql,
      encryptionKey: ENCRYPTION_KEY,
      defs: [flaky, fatal, greet],
      providers: {
        google: {
          createClient: (account) => ({ name: account.name }) as any,
          createAuth: (store) => ({
            getAuthUrl: (name) =>
              `https://auth.example.com/?state=${store.create(name)}`,
            async handleCallback(params) {
              const name = store.take(params.get('state') ?? '');
              if (!name) throw new Error('bad state');
              return { name, credential: `token-for-${name}` };
            },
          }),
        },
      },
      retryDelay: { base: 10, max: 50 },
      hooks: { onRunFailed: (event) => void failed.push(event) },
      server: { port: 0, adminToken: TOKEN },
    });

    await app.start();
    base = app.url!.toString().replace(/\/$/, '');
  });

  afterAll(async () => {
    await app?.stop();
    await db?.drop();
  });

  async function settled(id: string) {
    return waitFor(async () => {
      const run = await app.admin.getRun(id);
      return ['completed', 'failed'].includes(run.status) && run;
    });
  }

  test('retries resume after the last completed step', async () => {
    await app.admin.createFlow({ name: 'flaky.one', def: 'flaky' });
    const run = await settled((await app.admin.trigger('flaky.one')).id);

    expect(run.status).toBe('completed');
    expect(run.attempt).toBe(2);
    expect(run.output).toEqual({ a: 1 });
    expect(calls).toEqual({ a: 1, b: 2 });
    expect(run.steps.map((s) => [s.name, s.status, s.attempt])).toEqual([
      ['a', 'completed', 1],
      ['b', 'completed', 2],
    ]);
  });

  test('fatal errors fail immediately and fire the hook', async () => {
    await app.admin.createFlow({ name: 'fatal.one', def: 'fatal' });
    const run = await settled((await app.admin.trigger('fatal.one')).id);

    expect(run.status).toBe('failed');
    expect(run.attempt).toBe(1);
    expect(run.error).toBe('do not retry');
    await waitFor(async () => failed.length > 0);
    expect(failed[0]?.flow?.name).toBe('fatal.one');
  });

  test('health is public, admin routes need the token', async () => {
    expect(await (await fetch(`${base}/health`)).text()).toBe('OK');
    expect((await fetch(`${base}/flows`)).status).toBe(401);
    expect(
      (
        await fetch(`${base}/flows`, {
          headers: { Authorization: 'Bearer wrong' },
        })
      ).status,
    ).toBe(401);
  });

  test('connect an account through OAuth', async () => {
    const start = await fetch(
      `${base}/auth/google?name=personal&token=${TOKEN}`,
      { redirect: 'manual' },
    );
    expect(start.status).toBe(302);

    const location = new URL(start.headers.get('Location')!);
    const callback = await fetch(
      `${base}/auth/google/callback?state=${location.searchParams.get('state')}&code=x`,
    );
    expect(callback.status).toBe(200);
    expect(await callback.text()).toContain('Connected google/personal');

    const accounts = await read(api('/accounts'));
    expect(accounts).toMatchObject([{ provider: 'google', name: 'personal' }]);
    expect(JSON.stringify(accounts)).not.toContain('token-for');

    // states are single use
    const replay = await fetch(
      `${base}/auth/google/callback?state=${location.searchParams.get('state')}&code=x`,
    );
    expect(replay.status).toBe(400);
  });

  test('manage and run an instance over HTTP', async () => {
    const defs = await read(api('/defs'));
    expect(defs.find((d: any) => d.name === 'greet').config).toMatchObject({
      type: 'object',
      required: ['greeting'],
    });

    let res = await json('POST', '/flows', {
      name: 'greet.personal',
      def: 'greet',
      config: { greeting: 42 },
    });
    expect(res.status).toBe(400);

    res = await json('POST', '/flows', {
      name: 'greet.personal',
      def: 'greet',
      config: { greeting: 'hello' },
      schedules: [{ fre: 'day', expects: { hour: [7] } }],
    });
    expect(res.status).toBe(200);

    res = await json('PATCH', '/flows/greet.personal', { enabled: true });
    expect(res.status).toBe(400);
    expect((await read(res)).error).toMatch(/Missing binding/);

    res = await json('PUT', '/flows/greet.personal/bindings/google', {
      account: 'personal',
    });
    expect(res.status).toBe(200);

    res = await json('PATCH', '/flows/greet.personal', { enabled: true });
    const flow = await read(res);
    expect(flow.enabled).toBe(true);
    expect(flow.upcoming).toHaveLength(3);

    res = await json('POST', '/flows/greet.personal/run', { who: 'there' });
    const queued = await read(res);
    const run = await settled(queued.id);

    expect(run.output).toEqual({ text: 'hello there', account: 'personal' });

    const detail = await read(api(`/runs/${run.id}`));
    expect(detail.flow).toBe('greet.personal');
    expect(detail.steps).toHaveLength(1);

    const runs = await read(api('/runs?flow=greet.personal'));
    expect(runs.map((r: any) => r.id)).toEqual([run.id]);
  });

  test('not found and validation errors map to 404 and 400', async () => {
    expect((await api('/flows/ghost')).status).toBe(404);
    expect((await api('/runs/not-a-uuid')).status).toBe(404);
    expect((await api('/nope')).status).toBe(404);
    expect((await json('POST', '/flows', { name: 'x' })).status).toBe(400);
    expect(
      (
        await api('/flows', {
          method: 'POST',
          body: '{not json',
        })
      ).status,
    ).toBe(400);
  });

  test('failed runs can be retried', async () => {
    const [run] = await app.admin.listRuns({ flow: 'fatal.one' });
    const res = await json('POST', `/runs/${run!.id}/retry`);
    expect(res.status).toBe(200);

    const again = await settled(run!.id);
    expect(again.status).toBe('failed');
  });
});
