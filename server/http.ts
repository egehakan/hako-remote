import fs from "node:fs";
import path from "node:path";
import { serveStatic } from "@hono/node-server/serve-static";
import { type Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { isAllowedOrigin, safeEqual, type UserStore } from "./auth.ts";
import type { Config } from "./config.ts";
import { hashPassword, passwordProblem, verifyPassword } from "./password.ts";
import { type LoginLimiter, limiterKey } from "./rate-limit.ts";
import { cookieName, SESSION_TTL_MS, type SessionStore } from "./sessions.ts";

export type AppDeps = {
  config: Config;
  users: UserStore;
  sessions: SessionStore;
  limiter: LoginLimiter;
  /** Called with the hashes of sessions that just ended, so their sockets can be closed. */
  onSessionsEnded: (sessionHashes: string[]) => void;
};

const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "connect-src 'self'",
  "img-src 'self' data:",
  "style-src 'self' 'unsafe-inline'",
  "font-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

function readString(body: unknown, field: string): string | null {
  if (typeof body !== "object" || body === null) return null;
  const value = (body as Record<string, unknown>)[field];
  return typeof value === "string" ? value : null;
}

export function createApp(deps: AppDeps): Hono {
  const { config, users, sessions, limiter } = deps;
  const cookie = cookieName(config.secureCookies);
  const app = new Hono();

  app.use(async (c, next) => {
    await next();
    c.header("Content-Security-Policy", CONTENT_SECURITY_POLICY);
    c.header("X-Content-Type-Options", "nosniff");
    c.header("X-Frame-Options", "DENY");
    c.header("Referrer-Policy", "no-referrer");
    c.header("Cross-Origin-Opener-Policy", "same-origin");
    if (config.secureCookies) {
      c.header("Strict-Transport-Security", "max-age=31536000");
    }
  });

  app.get("/api/health", (c) => c.json({ ok: true }));

  app.use("/api/*", async (c, next) => {
    c.header("Cache-Control", "no-store");
    if (c.req.method !== "GET" && c.req.method !== "HEAD") {
      const origin = c.req.header("origin");
      if (origin !== undefined && !isAllowedOrigin(origin, config.origins)) {
        return c.json({ error: "forbidden_origin" }, 403);
      }
    }
    await next();
  });
  app.use("/api/*", bodyLimit({ maxSize: 16 * 1024 }));

  const currentSession = (value: string | undefined) => sessions.resolve(value);

  app.post("/api/login", async (c) => {
    const body: unknown = await c.req.json().catch(() => null);
    const email = readString(body, "email");
    const password = readString(body, "password");
    if (email === null || password === null || email.trim() === "" || password === "") {
      return c.json({ error: "bad_request" }, 400);
    }
    const key = limiterKey(email);
    const before = limiter.check(key);
    if (before.locked) return lockedResponse(c, before.retryAfterMs);

    const user = users.get();
    // The hash is checked even for an unknown email so both failures take the same time.
    const passwordOk = user ? await verifyPassword(password, user.passwordHash) : false;
    const emailOk = user ? safeEqual(key, user.email) : false;
    if (!passwordOk || !emailOk) {
      const after = limiter.recordFailure(key);
      if (after.locked) return lockedResponse(c, after.retryAfterMs);
      return c.json({ error: "invalid_credentials", remaining: after.remaining }, 401);
    }

    limiter.clear(key);
    const session = sessions.create();
    setCookie(c, cookie, session.cookie, {
      httpOnly: true,
      secure: config.secureCookies,
      sameSite: "Lax",
      path: "/",
      maxAge: Math.floor(SESSION_TTL_MS / 1000),
    });
    return c.json({ email: user!.email });
  });

  app.post("/api/logout", (c) => {
    const session = currentSession(getCookie(c, cookie));
    if (session) {
      sessions.delete(session);
      deps.onSessionsEnded([session]);
    }
    deleteCookie(c, cookie, { path: "/", secure: config.secureCookies });
    return c.json({ ok: true });
  });

  app.get("/api/me", (c) => {
    const user = currentSession(getCookie(c, cookie)) ? users.get() : null;
    return user ? c.json({ email: user.email }) : c.json({ error: "unauthorized" }, 401);
  });

  app.post("/api/password", async (c) => {
    const session = currentSession(getCookie(c, cookie));
    const user = session ? users.get() : null;
    if (!session || !user) return c.json({ error: "unauthorized" }, 401);

    const body: unknown = await c.req.json().catch(() => null);
    const current = readString(body, "current");
    const next = readString(body, "next");
    if (current === null || next === null) return c.json({ error: "bad_request" }, 400);

    const key = limiterKey(user.email);
    const before = limiter.check(key);
    if (before.locked) return lockedResponse(c, before.retryAfterMs);
    if (!(await verifyPassword(current, user.passwordHash))) {
      const after = limiter.recordFailure(key);
      if (after.locked) return lockedResponse(c, after.retryAfterMs);
      return c.json({ error: "invalid_credentials", remaining: after.remaining }, 403);
    }
    const problem = passwordProblem(next);
    if (problem) return c.json({ error: "weak_password", message: problem }, 400);

    users.setPasswordHash(await hashPassword(next));
    deps.onSessionsEnded(sessions.deleteOthers(session));
    return c.json({ ok: true });
  });

  app.all("/api/*", (c) => c.json({ error: "not_found" }, 404));
  app.all("/ws/*", (c) => c.text("Upgrade required", 426));

  const indexFile = path.join(config.clientDir, "index.html");
  app.use(
    serveStatic({
      root: path.relative(process.cwd(), config.clientDir) || ".",
      onFound: (file, c) => {
        const immutable = file.includes(`${path.sep}assets${path.sep}`);
        c.header("Cache-Control", immutable ? "public, max-age=31536000, immutable" : "no-cache");
      },
    }),
  );
  // Client-side routes fall back to the app shell; a missing file with an extension stays a 404.
  app.get("*", (c) => {
    if (path.extname(c.req.path) !== "" || !fs.existsSync(indexFile)) return c.notFound();
    c.header("Cache-Control", "no-cache");
    return c.html(fs.readFileSync(indexFile, "utf8"));
  });

  return app;
}

function lockedResponse(c: Context, retryAfterMs: number) {
  const seconds = Math.max(1, Math.ceil(retryAfterMs / 1000));
  c.header("Retry-After", String(seconds));
  return c.json({ error: "locked", retry_after: seconds }, 429);
}
