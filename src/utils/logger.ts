type Level = 'debug' | 'info' | 'warn' | 'error';

const LEVELS: Record<Level, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

function threshold(): number {
  const level = (Bun.env.LOG_LEVEL ?? 'info').toLowerCase() as Level;
  return LEVELS[level] ?? LEVELS.info;
}

export function createLogger(scope: string) {
  const min = threshold();
  const prefix = `[${scope}]`;

  function log(level: Level, message: string, ...args: unknown[]): void {
    if (LEVELS[level] < min) return;

    const line = `${new Date().toISOString()} ${level.toUpperCase()} ${prefix} ${message}`;
    const fn =
      level === 'error'
        ? console.error
        : level === 'warn'
          ? console.warn
          : console.log;
    fn(line, ...args);
  }

  return {
    debug: (message: string, ...args: unknown[]) =>
      log('debug', message, ...args),
    info: (message: string, ...args: unknown[]) =>
      log('info', message, ...args),
    warn: (message: string, ...args: unknown[]) =>
      log('warn', message, ...args),
    error: (message: string, ...args: unknown[]) =>
      log('error', message, ...args),
    child: (name: string) => createLogger(`${scope}:${name}`),
  };
}

export type Logger = ReturnType<typeof createLogger>;
