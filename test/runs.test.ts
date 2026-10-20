import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from 'bun:test';
import { createModules, type Modules } from '../src/modules';
import { defineFlow } from '../src/modules/flow/flow.registry';
import { createScheduler } from '../src/app/scheduler';
import { createSignal } from '../src/runtime/signal';
import type { Flow } from '../src/modules/flow/flow.types';
import {
  createTestDatabase,
  DATABASE_URL_TEST,
  ENCRYPTION_KEY,
} from './helpers';

const plain = defineFlow({ name: 'plain', async run() {} });
const MINUTE = 60_000;

describe.skipIf(!DATABASE_URL_TEST)('runs', () => {
  let db: Awaited<ReturnType<typeof createTestDatabase>>;
  let modules: Modules;

  beforeAll(async () => {
    db = await createTestDatabase();
    modules = createModules({
      sql: db.sql,
      encryptionKey: ENCRYPTION_KEY,
      defs: [plain],
      providers: {},
    });
  });

  afterAll(() => db?.drop());
  beforeEach(() => db.reset());

  function enqueue(flow: Flow, status: 'pending' | 'blocked' = 'pending') {
    return modules.runs.create({
      status,
      trigger: 'manual',
      flow_id: flow.id,
      def: flow.def,
      scheduled_at: new Date(),
    });
  }

  test('an instance never runs twice at once', async () => {
    const flow = await modules.flows.create({ name: 'p', def: 'plain' });
    const other = await modules.flows.create({ name: 'q', def: 'plain' });
    await enqueue(flow);
    await enqueue(flow);
    await enqueue(other);

    const first = await modules.runs.claim();
    const second = await modules.runs.claim();
    const third = await modules.runs.claim();

    expect(first?.flow_id).toBe(flow.id);
    expect(second?.flow_id).toBe(other.id);
    expect(third).toBeNull();
  });

  test('concurrent claims hand out each run once', async () => {
    for (let i = 0; i < 10; i++) {
      const flow = await modules.flows.create({ name: `f${i}`, def: 'plain' });
      await enqueue(flow);
    }

    const claimed = await Promise.all(
      Array.from({ length: 15 }, () => modules.runs.claim()),
    );
    const ids = claimed.filter((r) => r !== null).map((r) => r.id);

    expect(ids.length).toBe(10);
    expect(new Set(ids).size).toBe(10);
  });

  test('retry keeps the row and its completed steps', async () => {
    const flow = await modules.flows.create({ name: 'p', def: 'plain' });
    await enqueue(flow);
    const run = (await modules.runs.claim())!;

    const a = await modules.runs.startStep(run.id, 'a', run.attempt);
    await modules.runs.completeStep(a, { n: 1 });
    const b = await modules.runs.startStep(run.id, 'b', run.attempt);
    await modules.runs.failStep(b, new Error('boom'));

    await modules.runs.retry(run, new Error('boom'), new Date());
    const retried = (await modules.runs.claim())!;

    expect(retried.id).toBe(run.id);
    expect(retried.attempt).toBe(2);
    expect(await modules.runs.getStepMemo(run.id)).toEqual(
      new Map([['a', { n: 1 }]]),
    );

    // a failed step can run again, a completed one cannot
    await modules.runs.startStep(run.id, 'b', retried.attempt);
    await expect(
      modules.runs.startStep(run.id, 'a', retried.attempt),
    ).rejects.toThrow(/already completed/);
  });

  test('stale running runs are requeued', async () => {
    const flow = await modules.flows.create({ name: 'p', def: 'plain' });
    await enqueue(flow);
    const run = (await modules.runs.claim())!;

    await db.sql`
      UPDATE runs SET heartbeat_at = now() - INTERVAL '10 minutes'
      WHERE id = ${run.id}
    `;

    const reaped = await modules.runs.reap(new Date(Date.now() - 2 * MINUTE));
    expect(reaped.map((r) => [r.id, r.status, r.attempt])).toEqual([
      [run.id, 'pending', 2],
    ]);
  });

  test('children wait for the parent run and follow its outcome', async () => {
    const parent = await modules.flows.create({ name: 'parent', def: 'plain' });
    const child = await modules.flows.create({
      name: 'child',
      def: 'plain',
      parent: 'parent',
    });

    // no parent run yet
    const orphan = await enqueue(child, 'blocked');
    await modules.runs.resolveBlocked([orphan]);
    expect((await modules.runs.getById(orphan.id))?.status).toBe('failed');

    // parent in progress → blocked, then released on completion
    await enqueue(parent);
    const waiting = await enqueue(child, 'blocked');
    expect(await modules.runs.resolveBlocked([waiting])).toBe(0);

    const parentRun = (await modules.runs.claim())!;
    expect(parentRun.flow_id).toBe(parent.id);
    expect((await modules.runs.getById(waiting.id))?.parent_run).toBe(
      parentRun.id,
    );

    expect(await modules.runs.complete(parentRun.id, { ok: true })).toBe(1);
    expect((await modules.runs.getById(waiting.id))?.status).toBe('pending');

    // completed parent → immediately pending
    const ready = await enqueue(child, 'blocked');
    expect(await modules.runs.resolveBlocked([ready])).toBe(1);
  });

  test('a failed parent fails its blocked descendants', async () => {
    await modules.flows.create({ name: 'a', def: 'plain' });
    const b = await modules.flows.create({
      name: 'b',
      def: 'plain',
      parent: 'a',
    });
    const c = await modules.flows.create({
      name: 'c',
      def: 'plain',
      parent: 'b',
    });

    const aRun = await enqueue((await modules.flows.require('a'))!);
    const bRun = await enqueue(b, 'blocked');
    await modules.runs.resolveBlocked([bRun]);
    const cRun = await enqueue(c, 'blocked');
    await modules.runs.resolveBlocked([cRun]);

    await modules.runs.fail(aRun.id, new Error('nope'));

    expect((await modules.runs.getById(bRun.id))?.status).toBe('failed');
    expect((await modules.runs.getById(cRun.id))?.status).toBe('failed');
  });

  test('freshness rejects stale parent runs', async () => {
    const parent = await modules.flows.create({ name: 'parent', def: 'plain' });
    const child = await modules.flows.create({
      name: 'child',
      def: 'plain',
      parent: 'parent',
      freshness_seconds: 60,
    });

    const old = await enqueue(parent);
    await db.sql`
      UPDATE runs
      SET status = 'completed', completed_at = now() - INTERVAL '1 hour'
      WHERE id = ${old.id}
    `;

    const run = await enqueue(child, 'blocked');
    await modules.runs.resolveBlocked([run]);

    const after = await modules.runs.getById(run.id);
    expect(after?.status).toBe('failed');
    expect(after?.error).toMatch(/not fresh/);
  });

  test('scheduler enqueues only the latest missed occurrence', async () => {
    const flow = await modules.flows.create({
      name: 'p',
      def: 'plain',
      schedules: [{ fre: 'minute' }],
      enabled: true,
    });

    const scheduler = createScheduler(modules, createSignal());

    await scheduler.tick();
    const first = (await modules.flows.require('p'))!;
    expect(first.next_at!.getTime()).toBeGreaterThan(Date.now());
    expect(await modules.runs.list()).toHaveLength(0);

    // simulate 5 minutes of downtime
    const missed = new Date(Date.now() - 5 * MINUTE);
    await modules.flows.sync([{ id: flow.id, next_at: missed }]);
    await scheduler.tick();
    await scheduler.tick();

    const runs = await modules.runs.list();
    expect(runs).toHaveLength(1);
    expect(runs[0]?.trigger).toBe('schedule');
    expect(runs[0]!.scheduled_at.getTime()).toBeGreaterThan(missed.getTime());

    const after = (await modules.flows.require('p'))!;
    expect(after.next_at!.getTime()).toBeGreaterThan(Date.now());
  });

  test('scheduler disables flows whose schedule has ended', async () => {
    await modules.flows.create({
      name: 'p',
      def: 'plain',
      schedules: [{ fre: 'day', end: '2020-01-01' }],
      enabled: true,
    });

    await createScheduler(modules, createSignal()).tick();

    expect((await modules.flows.require('p')).enabled).toBe(false);
  });
});
