import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { HttpError } from './error';
import { createRequest } from './request';

let hits = 0;
let status: number[] = [];

const server = Bun.serve({
  port: 0,
  routes: {
    '/flaky': () => {
      hits++;
      return new Response(hits > 2 ? '{"ok":true}' : 'nope', {
        status: hits > 2 ? 200 : 503,
      });
    },
    '/status': () => {
      hits++;
      return new Response('x', { status: status.shift() ?? 200 });
    },
    '/auth': (req) => {
      hits++;
      const ok = req.headers.get('Authorization') === 'Bearer fresh';
      return new Response(ok ? '{"ok":true}' : 'unauthorized', {
        status: ok ? 200 : 401,
      });
    },
  },
});

const base = `http://localhost:${server.port}`;
const request = createRequest({ delayBase: 1, delayMax: 5 });

afterAll(() => server.stop(true));

beforeEach(() => {
  hits = 0;
  status = [];
});

describe('request', () => {
  test('retries idempotent requests on 5xx', async () => {
    expect(await request.json(`${base}/flaky`)).toEqual({ ok: true });
    expect(hits).toBe(3);
  });

  test('throws HttpError after max retries', async () => {
    status = [500, 500, 500, 500, 500];
    const promise = request(`${base}/status`, { maxRetries: 2 });

    await expect(promise).rejects.toBeInstanceOf(HttpError);
    await promise.catch(() => {});
    expect(hits).toBe(3);
  });

  test('does not retry non-idempotent requests on 5xx', async () => {
    status = [500, 200];
    await expect(request(`${base}/status`, { method: 'POST' })).rejects.toThrow(
      HttpError,
    );
  });

  test('retries 429 for any method', async () => {
    status = [429, 200];
    const res = await request(`${base}/status`, { method: 'POST' });
    expect(res.status).toBe(200);
    expect(hits).toBe(2);
  });

  test('refreshes auth once on 401', async () => {
    let refreshes = 0;
    const authed = request.with({
      auth: {
        authorize: async (headers) => {
          headers.set('Authorization', 'Bearer stale');
          return true;
        },
        refresh: async (headers) => {
          refreshes++;
          headers.set('Authorization', 'Bearer fresh');
          return true;
        },
      },
    });

    expect(await authed.json(`${base}/auth`)).toEqual({ ok: true });
    expect(refreshes).toBe(1);
    expect(hits).toBe(2);
  });

  test('appends params', async () => {
    const res = await request(`${base}/status`, {
      params: { a: 1, b: ['x', 'y'], c: undefined },
    });
    expect(new URL(res.url).search).toBe('?a=1&b=x&b=y');
  });
});
