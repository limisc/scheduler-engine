import { FatalError } from './error';

export function encode(str: string): string {
  return Buffer.from(str, 'utf-8').toString('base64');
}

export function decode(str: string): string {
  return Buffer.from(str, 'base64').toString('utf-8');
}

export function encodeUrl(str: string): string {
  return Buffer.from(str, 'utf-8').toString('base64url');
}

export function decodeUrl(str: string): string {
  return Buffer.from(str, 'base64url').toString('utf-8');
}

export function expect<T>(rows: T[], message = 'Expect a row'): T {
  const row = rows[0];
  if (!row) throw new FatalError(message);
  return row;
}

export function defined<T extends object>(input: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(input).filter(([, v]) => v !== undefined),
  ) as Partial<T>;
}

export function entries<T extends object>(
  obj: T,
): [keyof T, NonNullable<T[keyof T]>][] {
  return Object.entries(obj).filter(([, v]) => v != null) as any;
}

export function isEmpty(obj: object): boolean {
  return Object.keys(obj).length === 0;
}

export async function sleep(
  delay: number,
  signal?: AbortSignal | null,
): Promise<void> {
  if (signal?.aborted) throw signal.reason;

  await new Promise<void>((resolve, reject) => {
    let abort: (() => void) | undefined;

    const timer = setTimeout(() => {
      if (signal && abort) signal.removeEventListener('abort', abort);
      resolve();
    }, delay);

    if (signal) {
      abort = () => {
        clearTimeout(timer);
        reject(signal.reason);
      };

      signal.addEventListener('abort', abort, { once: true });
    }
  });
}

export function backoff(attempt: number, base: number, max: number): number {
  const delay = base * 2 ** (attempt - 1);
  return Math.min(max, delay + Math.random() * delay * 0.2);
}
