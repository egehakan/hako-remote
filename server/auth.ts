import { createHash, timingSafeEqual } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { hashPassword } from "./password.ts";

/** Compares two strings without leaking where they differ or how long the expected one is. */
export function safeEqual(given: string, expected: string): boolean {
  const a = createHash("sha256").update(given).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

export function bearerToken(header: string | undefined): string | null {
  if (!header) return null;
  const match = /^Bearer\s+(\S+)$/i.exec(header.trim());
  return match ? match[1] : null;
}

export function isAllowedOrigin(origin: string | undefined, allowed: readonly string[]): boolean {
  return origin !== undefined && allowed.includes(origin);
}

export type User = { email: string; passwordHash: string };

export class UserStore {
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
  }

  get(): User | null {
    const row = this.db.prepare("SELECT email, password_hash FROM users WHERE id = 1").get();
    return row ? { email: String(row.email), passwordHash: String(row.password_hash) } : null;
  }

  /** Creates the single account when the database has none. Returns true when it did. */
  async ensure(email: string, initialPassword: string | null): Promise<boolean> {
    if (this.get()) return false;
    if (!initialPassword) {
      throw new Error(
        "The database has no user yet: set HAKO_INITIAL_PASSWORD for the first start",
      );
    }
    const hash = await hashPassword(initialPassword);
    this.db
      .prepare("INSERT INTO users (id, email, password_hash, updated_at) VALUES (1, ?, ?, ?)")
      .run(email, hash, Date.now());
    return true;
  }

  setPasswordHash(hash: string): void {
    this.db
      .prepare("UPDATE users SET password_hash = ?, updated_at = ? WHERE id = 1")
      .run(hash, Date.now());
  }
}
