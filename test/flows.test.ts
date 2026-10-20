import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from 'bun:test';
import { z } from 'zod';
import { createModules, type Modules } from '../src/modules';
import { defineFlow } from '../src/modules/flow/flow.registry';
import { NotFoundError, ValidationError } from '../src/utils/error';
import {
  createTestDatabase,
  DATABASE_URL_TEST,
  ENCRYPTION_KEY,
} from './helpers';

const cleanup = defineFlow({
  name: 'gmail-cleanup',
  slots: { google: { provider: 'google' } },
  config: z.object({
    query: z.string(),
    action: z.enum(['archive', 'trash']).default('archive'),
  }),
  async run() {},
});

const sheet = defineFlow({
  name: 'to-sheet',
  slots: { google: { provider: 'google', config: ['spreadsheetId'] } },
  async run() {},
});

const plain = defineFlow({ name: 'plain', async run() {} });

describe.skipIf(!DATABASE_URL_TEST)('flows', () => {
  let db: Awaited<ReturnType<typeof createTestDatabase>>;
  let modules: Modules;

  beforeAll(async () => {
    db = await createTestDatabase();
    modules = createModules({
      sql: db.sql,
      encryptionKey: ENCRYPTION_KEY,
      defs: [cleanup, sheet, plain],
      providers: {},
    });
  });

  afterAll(() => db?.drop());

  beforeEach(async () => {
    await db.reset();
    await modules.accounts.upsert({
      provider: 'google',
      name: 'personal',
      credential: 'refresh-token',
    });
  });

  test('accounts are encrypted at rest', async () => {
    const [row] = await db.sql`SELECT credential FROM accounts`;
    expect(row.credential).not.toContain('refresh-token');

    const account = await modules.accounts.require('google', 'personal');
    expect(account.credential).toBe('refresh-token');
  });

  test('creates an enabled instance with bindings and parsed config', async () => {
    const flow = await modules.flows.create({
      name: 'gmail-cleanup.personal',
      def: 'gmail-cleanup',
      schedules: [{ fre: 'day', expects: { hour: [6] } }],
      config: { query: 'older_than:7d' },
      bindings: { google: 'personal' },
      enabled: true,
    });

    expect(flow.enabled).toBe(true);
    expect(flow.config).toEqual({ query: 'older_than:7d', action: 'archive' });
    expect(await modules.flows.listBindings(flow.name)).toEqual([
      { slot: 'google', provider: 'google', account: 'personal' },
    ]);
  });

  test('the same definition can back several instances', async () => {
    await modules.accounts.upsert({
      provider: 'google',
      name: 'work',
      credential: 'x',
    });

    for (const account of ['personal', 'work']) {
      await modules.flows.create({
        name: `gmail-cleanup.${account}`,
        def: 'gmail-cleanup',
        config: { query: 'in:inbox' },
        bindings: { google: account },
        enabled: true,
      });
    }

    expect((await modules.flows.list()).map((f) => f.name)).toEqual([
      'gmail-cleanup.personal',
      'gmail-cleanup.work',
    ]);
  });

  test('rejects unknown definitions, bad names and invalid config', async () => {
    await expect(
      modules.flows.create({ name: 'x', def: 'missing' }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      modules.flows.create({ name: 'Bad Name', def: 'plain' }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      modules.flows.create({
        name: 'c',
        def: 'gmail-cleanup',
        config: { action: 'delete' },
      }),
    ).rejects.toThrow(/Invalid config/);
    await expect(
      modules.flows.create({
        name: 'c',
        def: 'plain',
        schedules: [{ fre: 'day', expects: { weekday: [1] } } as any],
      }),
    ).rejects.toThrow(/Invalid schedules/);
  });

  test('enabling requires bindings, valid config and account config', async () => {
    await modules.flows.create({ name: 'c', def: 'gmail-cleanup' });

    await expect(modules.flows.update('c', { enabled: true })).rejects.toThrow(
      /Invalid config/,
    );

    await modules.flows.update('c', { config: { query: 'x' } });
    await expect(modules.flows.update('c', { enabled: true })).rejects.toThrow(
      /Missing binding/,
    );

    await modules.flows.bind('c', 'google', 'personal');
    const flow = await modules.flows.update('c', { enabled: true });
    expect(flow.enabled).toBe(true);

    await modules.flows.create({
      name: 's',
      def: 'to-sheet',
      bindings: { google: 'personal' },
    });
    await expect(modules.flows.update('s', { enabled: true })).rejects.toThrow(
      /missing config: spreadsheetId/,
    );
  });

  test('bind validates slot and account', async () => {
    await modules.flows.create({ name: 'c', def: 'gmail-cleanup' });

    await expect(
      modules.flows.bind('c', 'nope', 'personal'),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      modules.flows.bind('c', 'google', 'ghost'),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  test('schedule and enabled changes reset next_at', async () => {
    const flow = await modules.flows.create({
      name: 'p',
      def: 'plain',
      schedules: [{ fre: 'day' }],
      enabled: true,
    });

    await modules.flows.sync([{ id: flow.id, next_at: new Date() }]);
    expect((await modules.flows.require('p')).next_at).not.toBeNull();

    const updated = await modules.flows.update('p', {
      schedules: [{ fre: 'hour' }],
    });
    expect(updated.next_at).toBeNull();
  });

  test('parent links reject cycles', async () => {
    await modules.flows.create({ name: 'a', def: 'plain' });
    await modules.flows.create({ name: 'b', def: 'plain', parent: 'a' });

    await expect(modules.flows.update('a', { parent: 'b' })).rejects.toThrow(
      /cycle/,
    );
    await expect(modules.flows.update('a', { parent: 'a' })).rejects.toThrow(
      /cycle/,
    );
    await expect(
      modules.flows.create({ name: 'c', def: 'plain', freshness_seconds: 60 }),
    ).rejects.toThrow(/requires a parent/);
  });

  test('removing a flow fails its queued runs', async () => {
    const flow = await modules.flows.create({ name: 'p', def: 'plain' });
    const run = await modules.runs.create({
      status: 'pending',
      trigger: 'manual',
      flow_id: flow.id,
      def: 'plain',
      scheduled_at: new Date(),
    });

    await modules.flows.remove('p');

    const after = await modules.runs.getById(run.id);
    expect(after?.status).toBe('failed');
    expect(after?.flow_id).toBeNull();
  });
});
