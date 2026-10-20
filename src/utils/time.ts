import { DateTime, IANAZone } from 'luxon';
import { z } from 'zod';

export type Unit = 'year' | 'month' | 'week' | 'day' | 'hour' | 'minute';

export const DEFAULT_ZONE = 'America/Denver';

const values = (min: number, max: number) =>
  z.array(z.number().int().min(min).max(max)).min(1);

const month = values(1, 12);
const weekday = values(1, 7); // 1 is Monday and 7 is Sunday
const day = values(1, 31);
const hour = values(0, 23);
const minute = values(0, 59);

const excludesSchema = z.strictObject({
  month: month.optional(),
  weekday: weekday.optional(),
  day: day.optional(),
  hour: hour.optional(),
  minute: minute.optional(),
  holidays: z.boolean().optional(),
});

const isoSchema = z
  .string()
  .refine((s) => DateTime.fromISO(s).isValid, 'Invalid ISO date');

const zoneSchema = z
  .string()
  .refine((s) => IANAZone.isValidZone(s), 'Invalid IANA time zone');

const base = {
  interval: z.number().int().min(1).optional(),
  excludes: excludesSchema.optional(),
  start: isoSchema.optional(),
  end: isoSchema.optional(),
  zone: zoneSchema.optional(),
};

export const scheduleSchema = z.discriminatedUnion('fre', [
  z.strictObject({ fre: z.literal('minute'), ...base }),
  z.strictObject({
    fre: z.literal('hour'),
    expects: z.strictObject({ minute: minute.optional() }).optional(),
    ...base,
  }),
  z.strictObject({
    fre: z.literal('day'),
    expects: z
      .strictObject({ hour: hour.optional(), minute: minute.optional() })
      .optional(),
    ...base,
  }),
  z.strictObject({
    fre: z.literal('week'),
    expects: z
      .strictObject({
        weekday: weekday.optional(),
        hour: hour.optional(),
        minute: minute.optional(),
      })
      .optional(),
    ...base,
  }),
  z.strictObject({
    fre: z.literal('month'),
    expects: z
      .strictObject({
        day: day.optional(),
        hour: hour.optional(),
        minute: minute.optional(),
      })
      .optional(),
    ...base,
  }),
  z.strictObject({
    fre: z.literal('year'),
    expects: z
      .strictObject({
        month: month.optional(),
        day: day.optional(),
        hour: hour.optional(),
        minute: minute.optional(),
      })
      .optional(),
    ...base,
  }),
]);

export const schedulesSchema = z.array(scheduleSchema).min(1);

export type Schedule = z.infer<typeof scheduleSchema>;
export type Excludes = z.infer<typeof excludesSchema>;
export type Expects = Omit<Excludes, 'holidays'>;

export function dt(
  date: number | string | Date | DateTime,
  zone = DEFAULT_ZONE,
): DateTime {
  if (typeof date === 'number') return DateTime.fromMillis(date, { zone });
  if (typeof date === 'string') return DateTime.fromISO(date, { zone });
  if (date instanceof Date) return DateTime.fromJSDate(date, { zone });

  return date;
}

export function ft(
  date: number | string | Date | DateTime,
  format = 'yyyy-MM-dd HH:mm',
  zone = DEFAULT_ZONE,
): string {
  return dt(date, zone).toFormat(format);
}

export function diff(start: DateTime, end: DateTime, unit: Unit): number {
  const d1 = start.startOf(unit);
  const d2 = end.startOf(unit);

  if (
    unit === 'day' ||
    unit === 'week' ||
    unit === 'month' ||
    unit === 'year'
  ) {
    return Math.floor(d2.diff(d1, unit).as(unit));
  }

  const adjust = d2.plus({ minute: d2.offset - d1.offset });
  return Math.floor(adjust.diff(d1, unit).as(unit));
}

export function match(d: DateTime, expects: Expects, nth?: number): boolean {
  const { month, day, weekday, hour, minute } = expects;

  if (nth !== undefined) {
    if (weekday?.length !== 1) {
      throw new Error('occurrence requires a single weekday');
    }
    if (!occurred(d, nth)) return false;
  }

  if (month !== undefined && !month.includes(d.month)) return false;
  if (day !== undefined && !day.includes(d.day)) return false;
  if (weekday !== undefined && !weekday.includes(d.weekday)) return false;
  if (hour !== undefined && !hour.includes(d.hour)) return false;
  if (minute !== undefined && !minute.includes(d.minute)) return false;

  return true;
}

/** US holidays (not observed-day shifted). */
export function isHoliday(d: DateTime): boolean {
  return (
    // New Year's Day
    match(d, { month: [1], day: [1] }) ||
    // Juneteenth
    match(d, { month: [6], day: [19] }) ||
    // Independence Day
    match(d, { month: [7], day: [4] }) ||
    // Christmas Day
    match(d, { month: [12], day: [25] }) ||
    // Martin Luther King Day (3rd Monday of January)
    match(d, { month: [1], weekday: [1] }, 3) ||
    // Presidents' Day (3rd Monday of February)
    match(d, { month: [2], weekday: [1] }, 3) ||
    // Memorial Day (last Monday of May)
    match(d, { month: [5], weekday: [1] }, -1) ||
    // Labor Day (1st Monday of September)
    match(d, { month: [9], weekday: [1] }, 1) ||
    // Thanksgiving Day (4th Thursday of November)
    match(d, { month: [11], weekday: [4] }, 4)
  );
}

export function excluded(d: DateTime, excludes?: Excludes): boolean {
  if (!excludes) return false;

  const { holidays, ...expects } = excludes;

  return (
    (!!holidays && isHoliday(d)) ||
    (Object.keys(expects).length > 0 && match(d, expects))
  );
}

function occurred(date: DateTime, nth: number): boolean {
  if (nth > 0) {
    return Math.floor((date.day - 1) / 7) + 1 === nth;
  }

  if (nth < 0) {
    const daysInMonth = date.daysInMonth ?? 31;
    return Math.floor((daysInMonth - date.day) / 7) + 1 === -nth;
  }

  return false;
}

/** Earliest occurrence strictly after `at` across all schedules. */
export function findEarliest(
  schedules: Schedule[],
  at = new Date(),
  zone = DEFAULT_ZONE,
): Date | null {
  let next: Date | null = null;

  for (const s of schedules) {
    const n = findNext(s, at, s.zone ?? zone);

    if (n !== null && (next === null || n.getTime() < next.getTime())) {
      next = n;
    }
  }

  return next;
}

/** Next `count` occurrences after `at`, e.g. to preview a schedule. */
export function upcoming(
  schedules: Schedule[],
  count: number,
  at = new Date(),
  zone = DEFAULT_ZONE,
): Date[] {
  const dates: Date[] = [];
  let next = findEarliest(schedules, at, zone);

  while (next !== null && dates.length < count) {
    dates.push(next);
    next = findEarliest(schedules, next, zone);
  }

  return dates;
}

function findNext(schedule: Schedule, at: Date, zone: string): Date | null {
  const { fre: unit, start, end } = schedule;
  const interval = Math.max(1, Math.floor(schedule.interval ?? 1));

  const now = dt(at, zone);

  const d1 = start ? dt(start, zone) : null;
  const d2 = end ? dt(end, zone) : null;

  if (d1 && d2 && d1 > d2) return null;
  if (d2 && now > d2) return null;

  let ptr = d1 ? d1.startOf(unit) : align(now, unit, interval);
  ptr = forward(ptr, now, unit, interval);

  for (let i = 0; i < 1024; i++) {
    const next = findCandidate(ptr, now, schedule);

    if (next && (!d1 || next >= d1)) {
      if (d2 && next > d2) return null;

      return next.toJSDate();
    }

    ptr = ptr.plus({ [unit]: interval });
    if (d2 && ptr > d2) return null;
  }

  return null;
}

function findCandidate(
  d: DateTime,
  now: DateTime,
  s: Schedule,
): DateTime | null {
  for (const next of search(d, s)) {
    if (next > now && !excluded(next, s.excludes)) {
      return next;
    }
  }

  return null;
}

function align(d: DateTime, unit: Unit, interval: number): DateTime {
  const d2 = d.startOf(unit);

  switch (unit) {
    case 'minute':
    case 'hour':
      return d2.minus({ [unit]: d[unit] % interval });
    default:
      return d2;
  }
}

function forward(
  from: DateTime,
  to: DateTime,
  unit: Unit,
  interval: number,
): DateTime {
  if (from >= to) return from;

  const elapsed = diff(from, to, unit);
  const steps = Math.floor(elapsed / interval);
  return steps > 0 ? from.plus({ [unit]: steps * interval }) : from;
}

function* search(d: DateTime, s: Schedule): Generator<DateTime> {
  switch (s.fre) {
    case 'minute': {
      yield d;
      break;
    }
    case 'hour': {
      const minutes = sorted(s.expects?.minute, 0);

      for (const minute of minutes) {
        yield d.set({ minute });
      }

      break;
    }
    case 'day': {
      const hours = sorted(s.expects?.hour, 0);
      const minutes = sorted(s.expects?.minute, 0);

      for (const hour of hours) {
        for (const minute of minutes) {
          yield d.set({ hour, minute });
        }
      }

      break;
    }
    case 'week': {
      const weekdays = sorted(s.expects?.weekday, 1);
      const hours = sorted(s.expects?.hour, 0);
      const minutes = sorted(s.expects?.minute, 0);

      const d2 = d.startOf('week');

      for (const weekday of weekdays) {
        const d3 = d2.plus({ days: weekday - 1 });

        for (const hour of hours) {
          for (const minute of minutes) {
            yield d3.set({ hour, minute });
          }
        }
      }

      break;
    }
    case 'month': {
      const days = sorted(s.expects?.day, 1);
      const hours = sorted(s.expects?.hour, 0);
      const minutes = sorted(s.expects?.minute, 0);

      const daysInMonth = d.daysInMonth ?? 31;

      for (const day of days) {
        if (day > daysInMonth) continue;

        for (const hour of hours) {
          for (const minute of minutes) {
            yield d.set({ day, hour, minute });
          }
        }
      }

      break;
    }
    case 'year': {
      const months = sorted(s.expects?.month, 1);
      const days = sorted(s.expects?.day, 1);
      const hours = sorted(s.expects?.hour, 0);
      const minutes = sorted(s.expects?.minute, 0);

      for (const month of months) {
        const d2 = d.set({ month, day: 1 });
        const daysInMonth = d2.daysInMonth ?? 31;

        for (const day of days) {
          if (day > daysInMonth) continue;

          for (const hour of hours) {
            for (const minute of minutes) {
              yield d2.set({ day, hour, minute });
            }
          }
        }
      }

      break;
    }
  }
}

function sorted(v: number[] | undefined, fallback: number): number[] {
  if (v === undefined || v.length === 0) return [fallback];

  return v.toSorted((a, b) => a - b);
}
