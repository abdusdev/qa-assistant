import { describe, expect, it } from 'vitest';
import { mapLimit } from '../../../src/util/concurrency.js';
import { similarity, wordsOf } from '../../../src/util/similarity.js';

describe('mapLimit', () => {
  it('returns results in input order whatever order the tasks finish in', async () => {
    const delays = [30, 5, 15];

    const results = await mapLimit(delays, 3, async (ms, index) => {
      await new Promise((resolve) => setTimeout(resolve, ms));
      return `task ${index} after ${ms}`;
    });

    expect(results).toEqual(['task 0 after 30', 'task 1 after 5', 'task 2 after 15']);
  });

  it('never runs more than the limit at once', async () => {
    let inFlight = 0;
    let peak = 0;

    await mapLimit(
      Array.from({ length: 10 }, (_, i) => i),
      3,
      async () => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 3));
        inFlight--;
      },
    );

    expect(peak).toBe(3);
  });

  it('treats a limit below one as one', async () => {
    let inFlight = 0;
    let peak = 0;

    await mapLimit([1, 2, 3], 0, async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 2));
      inFlight--;
    });

    expect(peak).toBe(1);
  });

  it('handles an empty list', async () => {
    expect(await mapLimit([], 3, async () => 1)).toEqual([]);
  });

  it('rejects when a task throws', async () => {
    await expect(
      mapLimit([1, 2, 3], 2, async (n) => {
        if (n === 2) throw new Error('boom');
        return n;
      }),
    ).rejects.toThrow('boom');
  });
});

describe('similarity', () => {
  it('is 1 for the same words and 0 for nothing in common', () => {
    expect(similarity('create shipments now', 'now shipments create')).toBe(1);
    expect(similarity('create shipments', 'delete orders')).toBe(0);
  });

  it('is between 0 and 1 for partly shared words', () => {
    expect(similarity('create shipments for orders', 'create labels for orders')).toBeCloseTo(0.5);
  });

  it('ignores letter case, punctuation, short words and filler words', () => {
    expect(similarity('The Order, is READY!', 'order ready')).toBe(1);
  });

  it('is 0 when either side has no meaningful words', () => {
    expect(similarity('', 'create shipments')).toBe(0);
    expect(similarity('a an of', 'the and')).toBe(0);
  });
});

describe('wordsOf', () => {
  it('returns unique lowercase words of three letters or more', () => {
    expect([...wordsOf('Ship SHIP ship, to 100 orders')].sort()).toEqual(['100', 'orders', 'ship']);
  });
});
