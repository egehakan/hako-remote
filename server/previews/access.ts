// Who may open a preview: one-time tickets from the app, and the cookie a ticket is exchanged for.

import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export const TICKET_TTL_MS = 60_000;
export const PREVIEW_COOKIE_TTL_MS = 12 * 60 * 60 * 1000;
/** More tickets than this waiting at once means something is minting them: the oldest go. */
const MAX_TICKETS = 256;

/**
 * One cookie for every preview origin, set for the whole preview domain so that a preview's other
 * ports are covered. `__Secure-` keeps a plain-HTTP page from setting it.
 */
export function previewCookieName(secure: boolean): string {
  return secure ? "__Secure-hako_preview" : "hako_preview";
}

/** Every spelling, so none ever reaches a dev server or is set by one. */
export const PREVIEW_COOKIE_NAMES: readonly string[] = [
  "__Secure-hako_preview",
  "__Host-hako_preview",
  "hako_preview",
];

type Ticket = { previewId: string; sessionHash: string; expiresAt: number };

function digest(ticket: string): string {
  return createHash("sha256").update(ticket).digest("hex");
}

/**
 * Tickets live in memory only: they are good for a minute, and a restart costs nothing more than
 * opening the preview again. Only a hash of each is kept, so looking one up leaks nothing by timing.
 */
export class TicketStore {
  private readonly tickets = new Map<string, Ticket>();
  private readonly now: () => number;

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  /** A random 32-byte ticket for one preview, bound to the login session that asked for it. */
  issue(previewId: string, sessionHash: string): string {
    this.prune();
    while (this.tickets.size >= MAX_TICKETS) {
      this.tickets.delete(this.tickets.keys().next().value!);
    }
    const ticket = randomBytes(32).toString("base64url");
    this.tickets.set(digest(ticket), {
      previewId,
      sessionHash,
      expiresAt: this.now() + TICKET_TTL_MS,
    });
    return ticket;
  }

  /**
   * Uses up a ticket. Returns the session it was issued to, or null when it is unknown, used,
   * expired or for another preview. A ticket shown at the wrong preview is used up all the same.
   */
  redeem(ticket: string | undefined | null, previewId: string): string | null {
    if (typeof ticket !== "string" || ticket.length === 0 || ticket.length > 128) return null;
    const key = digest(ticket);
    const found = this.tickets.get(key);
    if (!found) return null;
    this.tickets.delete(key);
    if (found.expiresAt <= this.now() || found.previewId !== previewId) return null;
    return found.sessionHash;
  }

  get size(): number {
    return this.tickets.size;
  }

  private prune(): void {
    const now = this.now();
    for (const [key, ticket] of this.tickets) {
      if (ticket.expiresAt <= now) this.tickets.delete(key);
    }
  }
}

function cookieKey(secret: string): Buffer {
  // A key of its own, so no session cookie's signature can ever pass for a preview cookie's.
  return createHmac("sha256", secret).update("hako preview cookie v1").digest();
}

function signature(payload: string, secret: string): string {
  return createHmac("sha256", cookieKey(secret)).update(payload).digest("base64url");
}

/** `<session hash>.<expiry, base 36>.<signature>` */
export function signPreviewCookie(sessionHash: string, expiresAt: number, secret: string): string {
  const payload = `${sessionHash}.${expiresAt.toString(36)}`;
  return `${payload}.${signature(payload, secret)}`;
}

/**
 * Returns the login session a preview cookie belongs to when it is signed by this relay and
 * unexpired; otherwise null. Whether that session is still live is the caller's question.
 */
export function verifyPreviewCookie(
  value: string | undefined | null,
  secret: string,
  now: number = Date.now(),
): string | null {
  if (typeof value !== "string" || value.length > 512) return null;
  const parts = value.split(".");
  if (parts.length !== 3) return null;
  const [sessionHash, expiry, given] = parts;
  if (!/^[0-9a-f]{64}$/.test(sessionHash) || !/^[0-9a-z]{1,12}$/.test(expiry)) return null;
  const expected = Buffer.from(signature(`${sessionHash}.${expiry}`, secret), "base64url");
  const provided = Buffer.from(given, "base64url");
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) return null;
  if (parseInt(expiry, 36) <= now) return null;
  return sessionHash;
}
