import { describe, expect, it } from 'vitest';
import { FakeClock } from './fake-clock';

describe('FakeClock', () => {
  it('returns the date it was constructed with', () => {
    const clock = new FakeClock(new Date('2026-07-15T09:00:00Z'));
    expect(clock.now()).toEqual(new Date('2026-07-15T09:00:00Z'));
  });

  it('setNow overrides the current time', () => {
    const clock = new FakeClock(new Date('2026-07-15T09:00:00Z'));
    clock.setNow(new Date('2026-07-16T00:00:00Z'));
    expect(clock.now()).toEqual(new Date('2026-07-16T00:00:00Z'));
  });

  it('advanceSeconds moves the clock forward', () => {
    const clock = new FakeClock(new Date('2026-07-15T09:00:00Z'));
    clock.advanceSeconds(90);
    expect(clock.now()).toEqual(new Date('2026-07-15T09:01:30Z'));
  });
});
