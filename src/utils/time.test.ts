import { describe, expect, test } from 'bun:test';
import {
  dt,
  findEarliest,
  isHoliday,
  scheduleSchema,
  upcoming,
  type Schedule,
} from './time';

const ZONE = 'America/Denver';
const at = (iso: string) => dt(iso, ZONE).toJSDate();
const iso = (date: Date | null) =>
  date ? dt(date, ZONE).toFormat("yyyy-MM-dd'T'HH:mm") : null;

describe('findEarliest', () => {
  test('daily at fixed hours', () => {
    const s: Schedule = { fre: 'day', expects: { hour: [7, 18] } };
    expect(iso(findEarliest([s], at('2026-10-12T06:59')))).toBe(
      '2026-10-12T07:00',
    );
    expect(iso(findEarliest([s], at('2026-10-12T07:00')))).toBe(
      '2026-10-12T18:00',
    );
    expect(iso(findEarliest([s], at('2026-10-12T18:00')))).toBe(
      '2026-10-13T07:00',
    );
  });

  test('every 15 minutes', () => {
    const s: Schedule = { fre: 'minute', interval: 15 };
    expect(iso(findEarliest([s], at('2026-10-12T10:07')))).toBe(
      '2026-10-12T10:15',
    );
    expect(iso(findEarliest([s], at('2026-10-12T10:15')))).toBe(
      '2026-10-12T10:30',
    );
  });

  test('hourly at minutes', () => {
    const s: Schedule = { fre: 'hour', expects: { minute: [5, 35] } };
    expect(iso(findEarliest([s], at('2026-10-12T10:20')))).toBe(
      '2026-10-12T10:35',
    );
  });

  test('weekdays skipping holidays', () => {
    const s: Schedule = {
      fre: 'week',
      expects: { weekday: [1, 2, 3, 4, 5], hour: [6] },
      excludes: { holidays: true },
    };
    // Fri 2026-07-03 06:00 -> Mon 07-06 (Sat/Sun not expected)
    expect(iso(findEarliest([s], at('2026-07-03T06:00')))).toBe(
      '2026-07-06T06:00',
    );
    // Thanksgiving 2026-11-26 is skipped
    expect(iso(findEarliest([s], at('2026-11-25T07:00')))).toBe(
      '2026-11-27T06:00',
    );
  });

  test('monthly skips short months', () => {
    const s: Schedule = { fre: 'month', expects: { day: [31], hour: [9] } };
    expect(iso(findEarliest([s], at('2026-01-31T10:00')))).toBe(
      '2026-03-31T09:00',
    );
  });

  test('yearly', () => {
    const s: Schedule = {
      fre: 'year',
      expects: { month: [4], day: [15], hour: [8] },
    };
    expect(iso(findEarliest([s], at('2026-10-12T00:00')))).toBe(
      '2027-04-15T08:00',
    );
  });

  test('earliest across schedules', () => {
    const a: Schedule = { fre: 'day', expects: { hour: [20] } };
    const b: Schedule = { fre: 'day', expects: { hour: [9] } };
    expect(iso(findEarliest([a, b], at('2026-10-12T10:00')))).toBe(
      '2026-10-12T20:00',
    );
  });

  test('start and end bounds', () => {
    const s: Schedule = {
      fre: 'day',
      expects: { hour: [7] },
      start: '2026-10-20',
      end: '2026-10-21T12:00',
    };
    expect(iso(findEarliest([s], at('2026-10-12T00:00')))).toBe(
      '2026-10-20T07:00',
    );
    expect(iso(findEarliest([s], at('2026-10-21T07:00')))).toBeNull();
  });

  test('every 2 days anchored by start', () => {
    const s: Schedule = {
      fre: 'day',
      interval: 2,
      expects: { hour: [7] },
      start: '2026-10-01',
    };
    expect(iso(findEarliest([s], at('2026-10-12T08:00')))).toBe(
      '2026-10-13T07:00',
    );
  });

  test('schedule zone overrides default zone', () => {
    const s: Schedule = {
      fre: 'day',
      expects: { hour: [9] },
      zone: 'America/New_York',
    };
    // 09:00 New York == 07:00 Denver
    expect(iso(findEarliest([s], at('2026-10-12T06:00')))).toBe(
      '2026-10-12T07:00',
    );
  });

  test('DST spring forward keeps wall clock time', () => {
    const s: Schedule = { fre: 'day', expects: { hour: [7] } };
    // US DST starts 2026-03-08
    expect(iso(findEarliest([s], at('2026-03-07T07:00')))).toBe(
      '2026-03-08T07:00',
    );
    expect(iso(findEarliest([s], at('2026-03-08T07:00')))).toBe(
      '2026-03-09T07:00',
    );
  });

  test('upcoming', () => {
    const s: Schedule = { fre: 'week', expects: { weekday: [1], hour: [8] } };
    const dates = upcoming([s], 3, at('2026-10-12T09:00')).map(iso);
    expect(dates).toEqual([
      '2026-10-19T08:00',
      '2026-10-26T08:00',
      '2026-11-02T08:00',
    ]);
  });
});

describe('isHoliday', () => {
  test('fixed and floating holidays', () => {
    expect(isHoliday(dt('2026-07-04', ZONE))).toBe(true);
    expect(isHoliday(dt('2026-05-25', ZONE))).toBe(true); // Memorial Day
    expect(isHoliday(dt('2026-01-19', ZONE))).toBe(true); // MLK Day
    expect(isHoliday(dt('2026-10-12', ZONE))).toBe(false);
  });
});

describe('scheduleSchema', () => {
  test('accepts valid schedules', () => {
    expect(
      scheduleSchema.safeParse({ fre: 'day', expects: { hour: [7] } }).success,
    ).toBe(true);
  });

  test('rejects expects not allowed for the frequency', () => {
    expect(
      scheduleSchema.safeParse({ fre: 'day', expects: { weekday: [1] } })
        .success,
    ).toBe(false);
  });

  test('rejects out of range values and bad zones', () => {
    expect(
      scheduleSchema.safeParse({ fre: 'day', expects: { hour: [24] } }).success,
    ).toBe(false);
    expect(
      scheduleSchema.safeParse({ fre: 'day', zone: 'Mars/Base' }).success,
    ).toBe(false);
  });
});
