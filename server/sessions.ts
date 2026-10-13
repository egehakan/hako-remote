import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export function cookieName(secure: boolean): string {
  // The __Host- prefix makes the browser refuse the cookie unless it is Secure, host-only and Path=/.
  return secure ? "__Host-hako_session" : "hako_session";
}

function sign(id: string, secret: string): string {
  return createHmac("sha256", secret).update(id).digest("base64url");
}

export function signSessionId(id: string, secret: string): string {
  return `${id}.${sign(id, secret)}`;
}

/** Returns the session id when the cookie value carries a valid signature, otherwise null. */
export function unsignSessionId(value: string, secret: string): string | null {
  const dot = value.lastIndexOf(".");
  if (dot <= 0) return null;
  const id = value.slice(0, dot);
  const given = Buffer.from(value.slice(dot + 1), "base64url");
  const expected = Buffer.from(sign(id, secret), "base64url");
  if (given.length !== expected.length) return null;
  return timingSafeEqual(given, expected) ? id : null;
}

export function hashSessionId(id: string): string {
  return createHash("sha256").update(id).digest("hex");
}

export class SessionStore {
  private readonly db: DatabaseSync;
  private readonly secret: string;
  private readonly now: () => number;

  constructor(db: DatabaseSync, secret: string, now: () => number = Date.now) {
    this.db = db;
    this.secret = secret;
    this.now = now;
  }

  /** Creates a session and returns the signed cookie value. Only a hash of the id is stored. */
  create(): { cookie: string; idHash: string; expiresAt: number } {
    const id = randomBytes(32).toString("base64url");
    const idHash = hashSessionId(id);
    const createdAt = this.now();
    const expiresAt = createdAt + SESSION_TTL_MS;
    this.db
      .prepare("INSERT INTO sessions (id_hash, created_at, expires_at) VALUES (?, ?, ?)")
      .run(idHash, createdAt, expiresAt);
    return { cookie: signSessionId(id, this.secret), idHash, expiresAt };
  }

  /** Returns the stored hash of a live session for a cookie value, or null. */
  resolve(cookie: string | undefined | null): string | null {
    if (!cookie) return null;
    const id = unsignSessionId(cookie, this.secret);
    if (id === null) return null;
    const idHash = hashSessionId(id);
    return this.isLive(idHash) ? idHash : null;
  }

  isLive(idHash: string): boolean {
    const row = this.db.prepare("SELECT expires_at FROM sessions WHERE id_hash = ?").get(idHash);
    return row !== undefined && Number(row.expires_at) > this.now();
  }

  delete(idHash: string): void {
    this.db.prepare("DELETE FROM sessions WHERE id_hash = ?").run(idHash);
  }

  /** Ends every session except `keep` and returns the hashes that were ended. */
  deleteOthers(keep: string): string[] {
    const rows = this.db.prepare("SELECT id_hash FROM sessions WHERE id_hash != ?").all(keep);
    this.db.prepare("DELETE FROM sessions WHERE id_hash != ?").run(keep);
    return rows.map((row) => String(row.id_hash));
  }

  prune(): void {
    this.db.prepare("DELETE FROM sessions WHERE expires_at <= ?").run(this.now());
  }
}

export function parseCookies(header: string | undefined): Map<string, string> {
  const cookies = new Map<string, string>();
  if (!header) return cookies;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    const name = part.slice(0, eq).trim();
    if (!cookies.has(name)) cookies.set(name, part.slice(eq + 1).trim());
  }
  return cookies;
}
