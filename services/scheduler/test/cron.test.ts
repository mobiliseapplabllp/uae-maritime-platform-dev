import { describe, expect, it } from 'vitest';
import { CronError, fromWallClock, isValidCron, isValidTimeZone, nextRun, parseCron, wallClock, zoneOffsetMs } from '../src/cron';

const at = (s: string) => new Date(s);
const iso = (d: Date) => d.toISOString();

describe('cron parser', () => {
  it('expands stars, lists, ranges, steps and names', () => {
    const spec = parseCron('*/15 9-17 1,15 JAN-MAR MON-FRI');
    expect([...spec.minute.values]).toEqual([0, 15, 30, 45]); expect(spec.minute.star).toBe(false);
    expect([...spec.hour.values]).toEqual([9, 10, 11, 12, 13, 14, 15, 16, 17]);
    expect([...spec.dom.values]).toEqual([1, 15]); expect([...spec.month.values]).toEqual([1, 2, 3]); expect([...spec.dow.values]).toEqual([1, 2, 3, 4, 5]);
    expect([...parseCron('0 0 * * 7').dow.values]).toEqual([0]);
    expect([...parseCron('5/20 * * * *').minute.values]).toEqual([5, 25, 45]);
    expect(parseCron('  0  7 * * *  ').expr).toBe('0 7 * * *');
  });
  it('rejects malformed expressions', () => {
    for (const bad of ['* * * *', '60 * * * *', '* 24 * * *', '* * 0 * *', '* * * 13 *', '* * * * 8', '*/0 * * * *', '5-1 * * * *', 'a b c d e', '', '1,,2 * * * *', '1/2/3 * * * *']) {
      expect(() => parseCron(bad), bad).toThrow(CronError); expect(isValidCron(bad)).toBe(false);
    }
    expect(isValidTimeZone('Asia/Dubai')).toBe(true); expect(isValidTimeZone('Mars/Olympus')).toBe(false);
  });
});

describe('next run', () => {
  it('steps every five minutes and never returns the current minute', () => {
    expect(iso(nextRun('*/5 * * * *', at('2026-03-01T10:02:30Z'), 'UTC'))).toBe('2026-03-01T10:05:00.000Z');
    expect(iso(nextRun('*/5 * * * *', at('2026-03-01T10:05:00Z'), 'UTC'))).toBe('2026-03-01T10:10:00.000Z');
    expect(iso(nextRun('*/5 * * * *', at('2026-03-01T10:04:59.900Z'), 'UTC'))).toBe('2026-03-01T10:05:00.000Z');
  });
  it('honours the job time zone: 07:00 on weekdays in Dubai is 03:00Z, skipping the weekend', () => {
    expect(iso(nextRun('0 7 * * 1-5', at('2026-03-06T05:00:00Z'), 'Asia/Dubai'))).toBe('2026-03-09T03:00:00.000Z');
    expect(iso(nextRun('0 7 * * 1-5', at('2026-03-09T02:59:00Z'), 'Asia/Dubai'))).toBe('2026-03-09T03:00:00.000Z');
    expect(iso(nextRun('0 7 * * 1-5', at('2026-03-09T03:00:00Z'), 'Asia/Dubai'))).toBe('2026-03-10T03:00:00.000Z');
    expect(iso(nextRun('30 2 * * *', at('2026-03-01T00:00:00Z'), 'Asia/Dubai'))).toBe('2026-03-01T22:30:00.000Z');
  });
  it('rolls over months, short months and the year end', () => {
    expect(iso(nextRun('0 9 31 * *', at('2026-04-01T00:00:00Z'), 'UTC'))).toBe('2026-05-31T09:00:00.000Z');
    expect(iso(nextRun('0 0 1 * *', at('2026-01-31T23:59:00Z'), 'UTC'))).toBe('2026-02-01T00:00:00.000Z');
    expect(iso(nextRun('0 0 29 2 *', at('2026-01-01T00:00:00Z'), 'UTC'))).toBe('2028-02-29T00:00:00.000Z');
    expect(iso(nextRun('0 0 1 1 *', at('2026-12-31T23:00:00Z'), 'UTC'))).toBe('2027-01-01T00:00:00.000Z');
    expect(iso(nextRun('59 23 31 12 *', at('2026-12-31T23:59:00Z'), 'UTC'))).toBe('2027-12-31T23:59:00.000Z');
    expect(iso(nextRun('30 2 * * *', at('2026-12-31T22:35:00Z'), 'Asia/Dubai'))).toBe('2027-01-01T22:30:00.000Z');
    expect(iso(nextRun('0 8 * * 1', at('2026-12-28T08:00:00Z'), 'UTC'))).toBe('2027-01-04T08:00:00.000Z');
  });
  it('treats day-of-month and day-of-week as alternatives when both are restricted', () => {
    expect(iso(nextRun('0 0 13 * 5', at('2026-03-01T00:00:00Z'), 'UTC'))).toBe('2026-03-06T00:00:00.000Z');
    expect(iso(nextRun('0 0 13 * 5', at('2026-03-06T00:00:00Z'), 'UTC'))).toBe('2026-03-13T00:00:00.000Z');
  });
  it('follows daylight-saving changes in zones that have them', () => {
    expect(zoneOffsetMs(at('2026-03-28T12:00:00Z'), 'Europe/London')).toBe(0);
    expect(zoneOffsetMs(at('2026-03-29T12:00:00Z'), 'Europe/London')).toBe(3600_000);
    expect(iso(nextRun('0 9 * * *', at('2026-03-28T12:00:00Z'), 'Europe/London'))).toBe('2026-03-29T08:00:00.000Z');
    expect(iso(nextRun('0 9 * * *', at('2026-10-24T12:00:00Z'), 'Europe/London'))).toBe('2026-10-25T09:00:00.000Z');
    expect(wallClock(at('2026-06-01T00:30:00Z'), 'Asia/Dubai')).toEqual({ year: 2026, month: 6, day: 1, hour: 4, minute: 30, second: 0 });
    expect(iso(fromWallClock({ year: 2026, month: 6, day: 1, hour: 4, minute: 30 }, 'Asia/Dubai'))).toBe('2026-06-01T00:30:00.000Z');
  });
  it('gives up on schedules that can never match', () => {
    expect(() => nextRun('0 0 30 2 *', at('2026-01-01T00:00:00Z'), 'UTC')).toThrow(/never matches/);
    expect(() => nextRun('0 0 * * *', at('2026-01-01T00:00:00Z'), 'Mars/Olympus')).toThrow(/time zone/);
  });
});
