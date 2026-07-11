import type { CircuitBreakerStatus } from "./types.js";

export function createCircuitBreaker(threshold?: number): {
  check(): boolean;
  recordSuccess(): void;
  recordFailure(): void;
  getStatus(): CircuitBreakerStatus;
} {
  const failureThreshold = threshold ?? 3;
  const COOLDOWN_MS = 30_000;
  const status: CircuitBreakerStatus = {
    state: "closed",
    consecutiveFailures: 0,
    openedAt: null,
    threshold: failureThreshold,
  };

  return {
    check(): boolean {
      if (status.state === "open") {
        if (status.openedAt && Date.now() - status.openedAt >= COOLDOWN_MS) {
          status.state = "half-open";
          return false;
        }
        return true;
      }
      return false;
    },
    recordSuccess(): void {
      status.consecutiveFailures = 0;
      status.state = "closed";
      status.openedAt = null;
    },
    recordFailure(): void {
      status.consecutiveFailures += 1;
      if (status.state === "half-open" || status.consecutiveFailures >= status.threshold) {
        status.state = "open";
        status.openedAt = Date.now();
      }
    },
    getStatus(): CircuitBreakerStatus {
      return { ...status };
    },
  };
}

export function calculateBackoff(
  attempt: number,
  baseDelayMs?: number,
  maxDelayMs?: number,
): number {
  const base = baseDelayMs ?? 1000;
  const max = maxDelayMs ?? 30000;
  const exp = base * Math.pow(2, Math.max(0, attempt - 1));
  const clamped = Math.min(exp, max);
  return Math.round(clamped * (0.5 + Math.random() * 0.5));
}

export function parseRetryAfter(retryAfter: string | null): number | null {
  if (!retryAfter) return null;
  const trimmed = retryAfter.trim();
  if (!trimmed) return null;

  const asSeconds = Number(trimmed);
  if (Number.isFinite(asSeconds) && asSeconds >= 0) {
    return Math.round(asSeconds * 1000);
  }

  const asDate = Date.parse(trimmed);
  if (Number.isFinite(asDate)) {
    const diff = asDate - Date.now();
    return diff > 0 ? diff : 0;
  }

  return null;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
