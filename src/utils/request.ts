import { backoff, sleep } from './common';
import { HttpError } from './error';

type Primitive = string | number | boolean | null | undefined;

export type Params = Record<string, Primitive | Primitive[]>;

export type BodyFactory = () =>
  | RequestInit['body']
  | Promise<RequestInit['body']>;

export interface RequestAuth {
  readonly authorize: (headers: Headers) => Promise<boolean>;
  readonly refresh?: (headers: Headers) => Promise<boolean>;
}

export interface RequestOptions extends Omit<RequestInit, 'body'> {
  auth?: RequestAuth;
  body?: RequestInit['body'] | BodyFactory;
  json?: unknown;
  params?: Params;
  /** Retries after the first attempt. */
  maxRetries?: number;
  delayBase?: number;
  delayMax?: number;
  timeout?: number;
}

const IDEMPOTENT_METHODS = [
  'GET',
  'HEAD',
  'PUT',
  'DELETE',
  'OPTIONS',
  'PROPFIND',
];

export async function _fetch(
  url: string,
  {
    method = 'GET',
    auth,
    json,
    params,
    headers: rawHeaders,
    body: rawBody,
    signal: userSignal,
    maxRetries = 3,
    delayBase = 1_000,
    delayMax = 30_000,
    timeout = 30_000,
    ...init
  }: RequestOptions = {},
): Promise<Response> {
  const isIdempotent = IDEMPOTENT_METHODS.includes(method.toUpperCase());
  const _url = appendParams(url, params);
  const headers = new Headers(rawHeaders);

  if (auth) {
    await auth.authorize(headers);
  }

  let _body = rawBody;
  if (json !== undefined) {
    _body = JSON.stringify(json);
    if (!headers.has('Content-Type')) {
      headers.set('Content-Type', 'application/json');
    }
  }

  let refreshed = false;
  for (let attempt = 0; ; attempt++) {
    const body = typeof _body === 'function' ? await _body() : _body;
    const timeoutSignal = AbortSignal.timeout(timeout);
    const signal = userSignal
      ? AbortSignal.any([userSignal, timeoutSignal])
      : timeoutSignal;

    let res: Response | undefined;
    let err: unknown;

    try {
      res = await fetch(_url, { ...init, method, headers, body, signal });
      if (res.ok) return res;
    } catch (error) {
      if (userSignal?.aborted) throw error;
      err = error;
    }

    if (res?.status === 401 && !refreshed && auth?.refresh) {
      refreshed = true;
      if (await auth.refresh(headers)) {
        await res.body?.cancel().catch(() => {});
        attempt--;
        continue;
      }
    }

    let retry = false;
    if (res) {
      retry =
        res.status === 429 ||
        (isIdempotent && (res.status === 408 || res.status >= 500));
    } else {
      retry = isIdempotent;
    }

    if (!retry || attempt >= maxRetries) {
      if (res) {
        const text = await res.text().catch(() => '');
        throw new HttpError(res.status, res.statusText, text);
      }

      throw err;
    }

    const delay = retryAfter(res) ?? backoff(attempt + 1, delayBase, delayMax);
    await res?.body?.cancel().catch(() => {});
    await sleep(Math.min(delay, delayMax), userSignal);
  }
}

export function createRequest(baseOptions: RequestOptions = {}) {
  const request = async (url: string, options: RequestOptions = {}) =>
    _fetch(url, mergeOptions(baseOptions, options));

  request.json = async <T = unknown>(
    url: string,
    options: RequestOptions = {},
  ): Promise<T> => {
    const headers = new Headers(options.headers);
    if (!headers.has('Accept')) headers.set('Accept', 'application/json');

    const res = await request(url, { ...options, headers });
    const text = await res.text();

    if (!text.trim()) {
      throw new Error('Expected JSON response, but received empty body');
    }

    return JSON.parse(text) as T;
  };

  request.text = async (
    url: string,
    options?: RequestOptions,
  ): Promise<string> => {
    const res = await request(url, options);
    return res.text();
  };

  request.blob = async (
    url: string,
    options?: RequestOptions,
  ): Promise<Blob> => {
    const res = await request(url, options);
    return res.blob();
  };

  request.with = (extra: RequestOptions) =>
    createRequest(mergeOptions(baseOptions, extra));

  return request;
}

export const request = createRequest();
export type Request = ReturnType<typeof createRequest>;

function appendParams(url: string, params?: Params): string {
  if (!params) return url;

  const _url = new URL(url);

  for (const [key, value] of Object.entries(params)) {
    if (value == null) continue;

    if (Array.isArray(value)) {
      for (const v of value) {
        if (v != null) _url.searchParams.append(key, String(v));
      }
    } else {
      _url.searchParams.set(key, String(value));
    }
  }

  return _url.toString();
}

function retryAfter(res: Response | undefined): number | undefined {
  const value = res?.headers.get('Retry-After');
  if (!value) return;

  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1_000);

  const at = Date.parse(value);
  return Number.isNaN(at) ? undefined : Math.max(0, at - Date.now());
}

function mergeOptions(
  base: RequestOptions,
  extra: RequestOptions,
): RequestOptions {
  const headers = new Headers(base.headers);
  if (extra.headers) {
    new Headers(extra.headers).forEach((v, k) => void headers.set(k, v));
  }

  return { ...base, ...extra, headers };
}
