import { createHash, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import type { BunRequest } from 'bun';
import type { Admin } from './admin';
import { parse } from '../modules/flow/flow.validator';
import { NotFoundError, ValidationError } from '../utils/error';
import { createLogger } from '../utils/logger';

export interface ServerOptions {
  port?: number;
  hostname?: string;
  /** Bearer token for admin routes; admin routes are disabled without it. */
  adminToken?: string;
}

type Handler<T extends string> = (req: BunRequest<T>) => Promise<unknown>;

export function createServer(
  admin: Admin,
  { port = 3000, hostname, adminToken }: ServerOptions = {},
) {
  const log = createLogger('Server');
  let server: Bun.Server<unknown> | null = null;

  function authorized(token: string | null | undefined): boolean {
    if (!adminToken || !token) return false;
    return timingSafeEqual(digest(token), digest(adminToken));
  }

  /** Admin JSON route: bearer auth, error mapping, JSON response. */
  function api<T extends string>(handler: Handler<T>) {
    return async (req: BunRequest<T>): Promise<Response> => {
      const header = req.headers.get('Authorization');
      const token = header?.startsWith('Bearer ') ? header.slice(7) : null;

      if (!authorized(token)) {
        return Response.json({ error: 'Unauthorized' }, { status: 401 });
      }

      try {
        const data = await handler(req);
        return data === undefined
          ? new Response(null, { status: 204 })
          : Response.json(data);
      } catch (error) {
        return toErrorResponse(error);
      }
    };
  }

  function toErrorResponse(error: unknown): Response {
    if (error instanceof ValidationError || error instanceof z.ZodError) {
      return Response.json({ error: error.message }, { status: 400 });
    }

    if (error instanceof NotFoundError) {
      return Response.json({ error: error.message }, { status: 404 });
    }

    log.error('request failed', error);
    return Response.json({ error: 'Internal Server Error' }, { status: 500 });
  }

  function start(): void {
    if (server) return;

    server = Bun.serve({
      port,
      hostname,
      routes: {
        '/health': new Response('OK'),

        // OAuth: opened in a browser, so the token travels as a query param
        '/auth/:provider': {
          GET(req) {
            const url = new URL(req.url);

            if (!authorized(url.searchParams.get('token'))) {
              return new Response('Unauthorized', { status: 401 });
            }

            try {
              const name = url.searchParams.get('name') ?? '';
              return Response.redirect(
                admin.connectUrl(req.params.provider, name),
                302,
              );
            } catch (error) {
              return toErrorResponse(error);
            }
          },
        },

        '/auth/:provider/callback': {
          async GET(req) {
            const { searchParams } = new URL(req.url);

            try {
              const account = await admin.completeAuth(
                req.params.provider,
                searchParams,
              );

              return html(
                `Connected ${account.provider}/${account.name}. You can close this tab.`,
              );
            } catch (error) {
              log.warn('OAuth callback failed', error);
              return html(`Connection failed: ${message(error)}`, 400);
            }
          },
        },

        '/defs': {
          GET: api(async () => admin.listDefs()),
        },

        '/flows': {
          GET: api(async () => admin.listFlows()),
          POST: api(async (req) => admin.createFlow(await body(req))),
        },

        '/flows/:name': {
          GET: api(async (req) => admin.getFlow(req.params.name)),
          PATCH: api(async (req) =>
            admin.updateFlow(req.params.name, await body(req)),
          ),
          DELETE: api(async (req) => admin.removeFlow(req.params.name)),
        },

        '/flows/:name/bindings/:slot': {
          PUT: api(async (req) => {
            const { account } = parse(
              z.object({ account: z.string().min(1) }),
              await body(req),
              'binding',
            );
            return admin.bind(req.params.name, req.params.slot, account);
          }),
          DELETE: api(async (req) =>
            admin.unbind(req.params.name, req.params.slot),
          ),
        },

        '/flows/:name/run': {
          POST: api(async (req) =>
            admin.trigger(req.params.name, await body(req)),
          ),
        },

        '/accounts': {
          GET: api(async () => admin.listAccounts()),
        },

        '/accounts/:provider/:name': {
          PUT: api(async (req) => {
            const { credential, config } = parse(
              z.object({
                credential: z.string().min(1),
                config: z.record(z.string(), z.unknown()).optional(),
              }),
              await body(req),
              'account',
            );
            return admin.setAccount(
              req.params.provider,
              req.params.name,
              credential,
              config,
            );
          }),
          DELETE: api(async (req) =>
            admin.removeAccount(req.params.provider, req.params.name),
          ),
        },

        '/runs': {
          GET: api(async (req) =>
            admin.listRuns(Object.fromEntries(new URL(req.url).searchParams)),
          ),
        },

        '/runs/:id': {
          GET: api(async (req) => admin.getRun(req.params.id)),
        },

        '/runs/:id/retry': {
          POST: api(async (req) => admin.retryRun(req.params.id)),
        },
      },

      fetch() {
        return Response.json({ error: 'Not Found' }, { status: 404 });
      },
    });

    log.info(`listening on ${server.url}`);
  }

  async function stop(): Promise<void> {
    if (!server) return;

    await server.stop();
    server = null;
  }

  return {
    start,
    stop,
    get url() {
      return server?.url;
    },
  };
}

function digest(value: string): Buffer {
  return createHash('sha256').update(value).digest();
}

async function body(req: Request): Promise<any> {
  const text = await req.text();
  if (!text.trim()) return {};

  try {
    return JSON.parse(text);
  } catch {
    throw new ValidationError('Invalid JSON body');
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function html(text: string, status = 200): Response {
  const escaped = text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

  return new Response(
    `<!doctype html><meta charset="utf-8"><title>Scheduler</title><p>${escaped}</p>`,
    { status, headers: { 'Content-Type': 'text/html; charset=utf-8' } },
  );
}
