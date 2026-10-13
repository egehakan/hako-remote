import type { DatabaseSync } from "node:sqlite";

export const MAX_FAILURES = 5;
export const LOCKOUT_MS = 15 * 60 * 1000;

export type LimitState = { locked: false; remaining: number } | { locked: true; retryAfterMs: number };

/**
 * Counts failed logins per key. Five failures inside 15 minutes lock the key until 15 minutes
 * after the fifth one; a success clears the count.
 */
export class LoginLimiter {
  private readonly db: DatabaseSync;
  private readonly now: () => number;

  constructor(db: DatabaseSync, now: () => number = Date.now) {
    this.db = db;
    this.now = now;
  }

  check(key: string): LimitState {
    const now = this.now();
    const latest = this.db
      .prepare("SELECT failed_at FROM login_attempts WHERE key = ? ORDER BY failed_at DESC LIMIT ?")
      .all(key, MAX_FAILURES)
      .map((row) => Number(row.failed_at));
    const newest = latest[0];
    const oldest = latest[MAX_FAILURES - 1];
    if (oldest !== undefined && newest - oldest < LOCKOUT_MS && now < newest + LOCKOUT_MS) {
      return { locked: true, retryAfterMs: newest + LOCKOUT_MS - now };
    }
    const recent = latest.filter((failedAt) => failedAt > now - LOCKOUT_MS).length;
    return { locked: false, remaining: Math.max(1, MAX_FAILURES - recent) };
  }

  recordFailure(key: string): LimitState {
    this.db.prepare("INSERT INTO login_attempts (key, failed_at) VALUES (?, ?)").run(key, this.now());
    return this.check(key);
  }

  clear(key: string): void {
    this.db.prepare("DELETE FROM login_attempts WHERE key = ?").run(key);
  }

  prune(): void {
    this.db.prepare("DELETE FROM login_attempts WHERE failed_at <= ?").run(this.now() - LOCKOUT_MS);
  }
}

/** Normalises an email into a limiter key of bounded length. */
export function limiterKey(email: string): string {
  return email.trim().toLowerCase().slice(0, 254);
}
