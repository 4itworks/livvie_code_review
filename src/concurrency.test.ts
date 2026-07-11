import { describe, it, expect } from 'vitest';
import { createSemaphore, mapWithConcurrency } from './concurrency.js';

describe('createSemaphore', () => {
  it('initial available = maxConcurrency', () => {
    const sem = createSemaphore(3);
    expect(sem.available).toBe(3);
  });

  it('maxConcurrency < 1 is clamped to 1', () => {
    const sem = createSemaphore(0);
    expect(sem.available).toBe(1);
  });

  it('after acquire: available decreases', async () => {
    const sem = createSemaphore(3);
    await sem.acquire();
    expect(sem.available).toBe(2);
  });

  it('after release: available increases', async () => {
    const sem = createSemaphore(3);
    const release = await sem.acquire();
    expect(sem.available).toBe(2);
    release();
    expect(sem.available).toBe(3);
  });

  it('multiple acquires: blocks when exhausted, resumes on release', async () => {
    const sem = createSemaphore(2);
    const release1 = await sem.acquire();
    const release2 = await sem.acquire();
    expect(sem.available).toBe(0);
    expect(sem.waiting).toBe(0);

    // Third acquire should block
    let resolved = false;
    const promise = sem.acquire().then((r) => {
      resolved = true;
      return r;
    });

    // Give microtask a chance to run
    await new Promise((r) => setTimeout(r, 10));
    expect(resolved).toBe(false);
    expect(sem.waiting).toBe(1);

    // Release one — the waiter should resolve
    release1();
    const release3 = await promise;
    expect(resolved).toBe(true);
    expect(sem.waiting).toBe(0);
    // The waiter's callback does count--, so count goes from 0 to -1
    expect(sem.available).toBe(-1);

    release2();
    release3();
    // release2 increments count (from -1 to 0), release3 increments again (0 to 1)
    expect(sem.available).toBe(1);
  });

  it('waiting count increases when blocked', async () => {
    const sem = createSemaphore(1);
    await sem.acquire(); // slot taken

    // Queue up 3 waiters
    sem.acquire();
    sem.acquire();
    sem.acquire();

    expect(sem.waiting).toBe(3);
  });
});

describe('mapWithConcurrency', () => {
  it('maps items with concurrency limit', async () => {
    const items = [1, 2, 3, 4, 5];
    const result = await mapWithConcurrency(
      items,
      async (n) => n * 2,
      2
    );
    expect(result).toEqual([2, 4, 6, 8, 10]);
  });

  it('preserves order of results', async () => {
    const items = [5, 1, 3, 2, 4];
    const result = await mapWithConcurrency(
      items,
      async (n) => {
        // Varying delays to test order preservation
        await new Promise((r) => setTimeout(r, (6 - n) * 5));
        return n * 10;
      },
      2
    );
    expect(result).toEqual([50, 10, 30, 20, 40]);
  });

  it('empty items → []', async () => {
    const result = await mapWithConcurrency(
      [],
      async (n: number) => n,
      3
    );
    expect(result).toEqual([]);
  });

  it('concurrency 1 → sequential execution', async () => {
    const order: number[] = [];
    const items = [1, 2, 3];
    const result = await mapWithConcurrency(
      items,
      async (n) => {
        order.push(n);
        return n;
      },
      1
    );
    expect(order).toEqual([1, 2, 3]);
    expect(result).toEqual([1, 2, 3]);
  });

  it('errors propagate (one failing item rejects the promise)', async () => {
    const items = [1, 2, 3];
    await expect(
      mapWithConcurrency(
        items,
        async (n) => {
          if (n === 2) throw new Error('boom');
          return n;
        },
        2
      )
    ).rejects.toThrow('boom');
  });

  it('respects concurrency limit', async () => {
    let running = 0;
    let maxRunning = 0;
    const items = [1, 2, 3, 4, 5, 6];
    await mapWithConcurrency(
      items,
      async (n) => {
        running++;
        maxRunning = Math.max(maxRunning, running);
        await new Promise((r) => setTimeout(r, 10));
        running--;
        return n;
      },
      2
    );
    expect(maxRunning).toBeLessThanOrEqual(2);
  });
});
