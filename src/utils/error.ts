export class HttpError extends Error {
  constructor(
    public status: number,
    public statusText: string,
    public body: string,
  ) {
    super(`Http Error [${status} ${statusText}]: ${body.slice(0, 200)}`);
    this.name = 'HttpError';
  }
}

/** A non-retryable error: the run fails immediately. */
export class FatalError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'FatalError';
  }
}

/** Invalid input from an admin caller (HTTP 400). */
export class ValidationError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ValidationError';
  }
}

export class NotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NotFoundError';
  }
}

export function formatError(error: unknown): string {
  if (error instanceof AggregateError) {
    const inner = error.errors.map(formatError).join('; ');
    return `${error.message}: ${inner}`;
  }

  return error instanceof Error ? error.message : String(error);
}

export function isFatalError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  if (error instanceof FatalError) return true;

  if (error instanceof HttpError) {
    const { status } = error;
    return status >= 400 && status < 500 && status !== 408 && status !== 429;
  }

  return false;
}
