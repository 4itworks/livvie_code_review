import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createCircuitBreaker, calculateBackoff, parseRetryAfter } from "./circuit-breaker.js";

describe("createCircuitBreaker", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("initial state is closed, check() returns false", () => {
    const cb = createCircuitBreaker();
    expect(cb.check()).toBe(false);
    expect(cb.getStatus()).toEqual({
      state: "closed",
      consecutiveFailures: 0,
      openedAt: null,
      threshold: 3,
    });
  });

  it("after threshold failures: state is open, check() returns true", () => {
    const cb = createCircuitBreaker(3);
    cb.recordFailure();
    cb.recordFailure();
    expect(cb.getStatus().state).toBe("closed");
    cb.recordFailure();
    expect(cb.getStatus().state).toBe("open");
    expect(cb.check()).toBe(true);
  });

  it("custom threshold works", () => {
    const cb = createCircuitBreaker(1);
    cb.recordFailure();
    expect(cb.getStatus().state).toBe("open");
    expect(cb.check()).toBe(true);
  });

  it("after cooldown (30s), check() transitions to half-open and returns false", () => {
    const cb = createCircuitBreaker(3);
    cb.recordFailure();
    cb.recordFailure();
    cb.recordFailure();
    expect(cb.getStatus().state).toBe("open");
    expect(cb.check()).toBe(true);

    // Advance time past the 30s cooldown
    vi.advanceTimersByTime(31000);
    expect(cb.check()).toBe(false);
    expect(cb.getStatus().state).toBe("half-open");
  });

  it("half-open + success transitions to closed", () => {
    const cb = createCircuitBreaker(1);
    cb.recordFailure(); // opens
    expect(cb.getStatus().state).toBe("open");

    vi.advanceTimersByTime(31000);
    cb.check(); // transitions to half-open
    expect(cb.getStatus().state).toBe("half-open");

    cb.recordSuccess();
    expect(cb.getStatus().state).toBe("closed");
    expect(cb.getStatus().consecutiveFailures).toBe(0);
    expect(cb.getStatus().openedAt).toBeNull();
  });

  it("half-open + failure transitions back to open", () => {
    const cb = createCircuitBreaker(1);
    cb.recordFailure(); // opens
    vi.advanceTimersByTime(31000);
    cb.check(); // half-open

    cb.recordFailure();
    expect(cb.getStatus().state).toBe("open");
  });

  it("recordSuccess resets consecutive failures", () => {
    const cb = createCircuitBreaker(5);
    cb.recordFailure();
    cb.recordFailure();
    expect(cb.getStatus().consecutiveFailures).toBe(2);
    cb.recordSuccess();
    expect(cb.getStatus().consecutiveFailures).toBe(0);
    expect(cb.getStatus().state).toBe("closed");
  });

  it("getStatus returns a copy of internal state", () => {
    const cb = createCircuitBreaker();
    const status1 = cb.getStatus();
    const status2 = cb.getStatus();
    expect(status1).toEqual(status2);
    expect(status1).not.toBe(status2);
  });

  it("check returns false while closed even with some failures", () => {
    const cb = createCircuitBreaker(5);
    cb.recordFailure();
    cb.recordFailure();
    expect(cb.check()).toBe(false);
    expect(cb.getStatus().state).toBe("closed");
  });

  it("cooldown not yet elapsed keeps circuit open", () => {
    const cb = createCircuitBreaker(1);
    cb.recordFailure(); // opens
    vi.advanceTimersByTime(10000); // only 10s, not enough
    expect(cb.check()).toBe(true);
    expect(cb.getStatus().state).toBe("open");
  });
});

describe("calculateBackoff", () => {
  it("attempt 1: ~1000ms (base)", () => {
    // With jitter: 1000 * (0.5 + random * 0.5), range [500, 1000]
    const result = calculateBackoff(1);
    expect(result).toBeGreaterThanOrEqual(500);
    expect(result).toBeLessThanOrEqual(1000);
  });

  it("attempt 2: ~2000ms", () => {
    // 2000 * (0.5 + random * 0.5), range [1000, 2000]
    const result = calculateBackoff(2);
    expect(result).toBeGreaterThanOrEqual(1000);
    expect(result).toBeLessThanOrEqual(2000);
  });

  it("attempt 3: ~4000ms", () => {
    // 4000 * (0.5 + random * 0.5), range [2000, 4000]
    const result = calculateBackoff(3);
    expect(result).toBeGreaterThanOrEqual(2000);
    expect(result).toBeLessThanOrEqual(4000);
  });

  it("clamped at max (30000)", () => {
    // attempt 20 would be 2^19 * 1000 = huge, should be clamped to 30000
    // With jitter: 30000 * (0.5 + random * 0.5), range [15000, 30000]
    const result = calculateBackoff(20);
    expect(result).toBeGreaterThanOrEqual(15000);
    expect(result).toBeLessThanOrEqual(30000);
  });

  it("returns a number > 0 for any attempt", () => {
    for (let i = 0; i <= 10; i++) {
      expect(calculateBackoff(i)).toBeGreaterThan(0);
    }
  });

  it("custom base and max", () => {
    // base=500, max=5000, attempt=1: 500 * (0.5+random*0.5), range [250, 500]
    const result = calculateBackoff(1, 500, 5000);
    expect(result).toBeGreaterThanOrEqual(250);
    expect(result).toBeLessThanOrEqual(500);
  });

  it("attempt 0 treated as non-negative exponent", () => {
    // 1000 * 2^max(0, -1) = 1000 * 1 = 1000
    const result = calculateBackoff(0);
    expect(result).toBeGreaterThanOrEqual(500);
    expect(result).toBeLessThanOrEqual(1000);
  });
});

describe("parseRetryAfter", () => {
  it("null returns null", () => {
    expect(parseRetryAfter(null)).toBeNull();
  });

  it('"5" returns 5000 (5 seconds in ms)', () => {
    expect(parseRetryAfter("5")).toBe(5000);
  });

  it("empty string returns null", () => {
    expect(parseRetryAfter("")).toBeNull();
  });

  it('"0" returns 0', () => {
    expect(parseRetryAfter("0")).toBe(0);
  });

  it("future date string returns positive number", () => {
    const futureDate = new Date(Date.now() + 60000).toUTCString();
    const result = parseRetryAfter(futureDate);
    expect(result).toBeGreaterThan(0);
    expect(result).toBeLessThanOrEqual(60000);
  });

  it("invalid string returns null", () => {
    expect(parseRetryAfter("not-a-date-or-number")).toBeNull();
  });

  it("whitespace-only string returns null", () => {
    expect(parseRetryAfter("   ")).toBeNull();
  });

  it("whitespace-padded number is trimmed and parsed", () => {
    expect(parseRetryAfter("  10  ")).toBe(10000);
  });
});
