import type { Semaphore } from "./types.js";

export function createSemaphore(maxConcurrency: number): Semaphore {
  let count = Math.max(1, Math.floor(maxConcurrency));
  const waiters: Array<() => void> = [];

  function release(): void {
    if (waiters.length > 0) {
      const next = waiters.shift()!;
      next();
      return;
    }
    count++;
  }

  return {
    acquire(): Promise<() => void> {
      if (count > 0) {
        count--;
        return Promise.resolve(release);
      }
      return new Promise<() => void>((resolve) => {
        waiters.push(() => {
          count--;
          resolve(release);
        });
      });
    },
    get available(): number {
      return count;
    },
    get waiting(): number {
      return waiters.length;
    },
  };
}

export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  mapper: (item: T, index: number) => Promise<R>,
  concurrency: number,
): Promise<R[]> {
  const semaphore = createSemaphore(concurrency);
  const promises = items.map((item, index) =>
    (async (): Promise<R> => {
      const release = await semaphore.acquire();
      try {
        return await mapper(item, index);
      } finally {
        release();
      }
    })(),
  );
  return Promise.all(promises);
}
