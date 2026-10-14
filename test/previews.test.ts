import assert from "node:assert/strict";
import { test } from "node:test";
import { type PreviewAddressing, previewAddressingFrom } from "../server/config.ts";
import {
  signPreviewCookie,
  TICKET_TTL_MS,
  TicketStore,
  verifyPreviewCookie,
} from "../server/previews/access.ts";
import { PortMap, parsePreviewHost } from "../server/previews/host.ts";
import {
  cspAllowsClientScript,
  injectClientScript,
  injectionPoint,
  rewriteRequestHeaders,
  rewriteResponseHeaders,
  rewriteSetCookie,
} from "../server/previews/rewrite.ts";
import { signSessionId, unsignSessionId } from "../server/sessions.ts";
import { isPreviewId, ReceiveWindow, SendWindow } from "../shared/previews.ts";

const SECRET = "a-session-secret-of-some-length";
const SESSION = "a".repeat(64);
const PROD: PreviewAddressing = { domain: "hako.example.com", scheme: "https:", port: "" };
const LOCAL: PreviewAddressing = { domain: "hako.localhost", scheme: "http:", port: ":8790" };

test("a ticket opens one preview once, within a minute, for the session it was issued to", () => {
  let now = 1_000;
  const tickets = new TicketStore(() => now);
  const ticket = tickets.issue("myapp", SESSION);
  assert.match(ticket, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(tickets.redeem(ticket, "myapp"), SESSION);
  assert.equal(tickets.redeem(ticket, "myapp"), null, "used");

  const late = tickets.issue("myapp", SESSION);
  now += TICKET_TTL_MS;
  assert.equal(tickets.redeem(late, "myapp"), null, "expired");

  const elsewhere = tickets.issue("myapp", SESSION);
  assert.equal(tickets.redeem(elsewhere, "other"), null, "another preview");
  assert.equal(tickets.redeem(elsewhere, "myapp"), null, "used up at the wrong preview");

  assert.equal(tickets.redeem("made-up", "myapp"), null);
  assert.equal(tickets.redeem(undefined, "myapp"), null);
  assert.equal(tickets.redeem("x".repeat(500), "myapp"), null);
});

test("the preview cookie is signed, bound to a session, expires, and is never a session cookie", () => {
  const now = Date.now();
  const cookie = signPreviewCookie(SESSION, now + 60_000, SECRET);
  assert.equal(verifyPreviewCookie(cookie, SECRET, now), SESSION);
  assert.equal(verifyPreviewCookie(cookie, SECRET, now + 60_000), null, "expired");
  assert.equal(verifyPreviewCookie(cookie, "another-secret-of-some-length", now), null);

  const [hash, expiry, signature] = cookie.split(".");
  const forged = [
    `${"b".repeat(64)}.${expiry}.${signature}`,
    `${hash}.${(now + 10 ** 9).toString(36)}.${signature}`,
    `${hash}.${expiry}.${signature.slice(0, -2)}AA`,
    `${hash}.${expiry}`,
    "",
  ];
  for (const value of forged) assert.equal(verifyPreviewCookie(value, SECRET, now), null, value);

  // Signed with a key of its own: neither cookie passes for the other.
  assert.equal(unsignSessionId(cookie, SECRET), null);
  const session = signSessionId("some-session-id", SECRET);
  assert.equal(verifyPreviewCookie(session, SECRET, now), null);
});

test("a host names the app, a preview's main port, another of its ports, or nothing", () => {
  assert.deepEqual(parsePreviewHost("myapp.hako.example.com", PROD), {
    kind: "preview",
    id: "myapp",
    port: null,
  });
  assert.deepEqual(parsePreviewHost("MyApp--8087.Hako.Example.com.", PROD), {
    kind: "preview",
    id: "myapp",
    port: 8087,
  });
  assert.deepEqual(parsePreviewHost("web-1.hako.localhost:8790", LOCAL), {
    kind: "preview",
    id: "web-1",
    port: null,
  });
  for (const host of ["hako.example.com", "example.com", "evil-hako.example.com", "x.other.com"]) {
    assert.deepEqual(parsePreviewHost(host, PROD), { kind: "app" }, host);
  }
  assert.deepEqual(parsePreviewHost("x.hako.example.com", null), { kind: "app" });
  for (const label of [
    "www",
    "api",
    "admin",
    "-a",
    "a-",
    "a.b",
    "a--b",
    "a--0",
    "a--70000",
    "x_y",
  ]) {
    assert.equal(parsePreviewHost(`${label}.hako.example.com`, PROD).kind, "invalid", label);
  }
  assert.equal(isPreviewId("a".repeat(40)), true);
  assert.equal(isPreviewId("a".repeat(41)), false);
  assert.equal(isPreviewId("my--app"), false);
});

test("a port map turns localhost addresses of the preview's ports into its origins and back", () => {
  const map = new PortMap("myapp", [8086, 8087], PROD);
  assert.equal(map.toPublic("http://localhost:8086/a?b#c"), "https://myapp.hako.example.com/a?b#c");
  assert.equal(map.toPublic("http://127.0.0.1:8087"), "https://myapp--8087.hako.example.com");
  assert.equal(map.toPublic("ws://[::1]:8087/ws"), "wss://myapp--8087.hako.example.com/ws");
  assert.equal(map.toPublic("http://localhost:9000/x"), "http://localhost:9000/x", "not its port");
  assert.equal(map.toPublic("/relative"), "/relative");
  assert.equal(map.toLocal("https://myapp--8087.hako.example.com/p"), "http://localhost:8087/p");
  assert.equal(map.toLocal("https://other.hako.example.com/p"), "https://other.hako.example.com/p");
});

const RAW_REQUEST = [
  "Host",
  "myapp.hako.example.com",
  "Accept-Encoding",
  "gzip, br",
  "Cookie",
  "__Secure-hako_preview=abc; theme=dark; hako_preview=x",
  "Origin",
  "https://myapp.hako.example.com",
  "Referer",
  "https://myapp--8087.hako.example.com/page?q=1",
  "Connection",
  "keep-alive, X-Secret",
  "X-Secret",
  "hop",
  "X-Forwarded-For",
  "203.0.113.9",
  "Accept",
  "text/html",
];

test("a request reaches the dev server as if sent on the Mac, without the preview cookie", () => {
  const headers = rewriteRequestHeaders(RAW_REQUEST, {
    map: new PortMap("myapp", [8086, 8087], PROD),
    port: 8086,
    previewHost: "myapp.hako.example.com",
    scheme: "https:",
    clientAddress: "10.0.0.2",
    upgrade: null,
  });
  assert.deepEqual(headers, [
    ["Host", "localhost:8086"],
    ["Cookie", "theme=dark"],
    ["Origin", "http://localhost:8086"],
    ["Referer", "http://localhost:8087/page?q=1"],
    ["Accept", "text/html"],
    ["X-Forwarded-Host", "myapp.hako.example.com"],
    ["X-Forwarded-Proto", "https"],
    ["X-Forwarded-For", "203.0.113.9, 10.0.0.2"],
  ]);

  const foreign = rewriteRequestHeaders(
    [
      "Origin",
      "https://other.hako.example.com",
      "Cookie",
      "hako_preview=1",
      "Upgrade",
      "websocket",
    ],
    {
      map: new PortMap("myapp", [8086], PROD),
      port: 8086,
      previewHost: "myapp.hako.example.com",
      scheme: "https:",
      clientAddress: null,
      upgrade: "websocket",
    },
  );
  assert.deepEqual(foreign, [
    ["Host", "localhost:8086"],
    ["Origin", "https://other.hako.example.com"],
    ["X-Forwarded-Host", "myapp.hako.example.com"],
    ["X-Forwarded-Proto", "https"],
    ["Connection", "Upgrade"],
    ["Upgrade", "websocket"],
  ]);
});

test("a response points back at preview origins, shares its cookies and lets only the app frame it", () => {
  const headers = rewriteResponseHeaders(
    [
      "Location",
      "http://localhost:8086/next",
      "Access-Control-Allow-Origin",
      "http://localhost:8086",
      "Link",
      "<http://localhost:8087/a.js>; rel=preload, </b.css>; rel=preload",
      "Refresh",
      "3; url=http://127.0.0.1:8087/x",
      "Set-Cookie",
      "sid=1; Path=/; Domain=localhost; HttpOnly",
      "Set-Cookie",
      "__Host-x=1; Path=/; Secure",
      "Set-Cookie",
      "__Secure-hako_preview=evil; Domain=hako.example.com",
      "Set-Cookie",
      "hako_session=evil",
      "X-Frame-Options",
      "DENY",
      "Content-Security-Policy",
      "default-src 'self'; frame-ancestors 'none'",
      "Content-Security-Policy",
      "frame-ancestors 'self'",
      "Transfer-Encoding",
      "chunked",
      "Content-Type",
      "text/html",
    ],
    {
      map: new PortMap("myapp", [8086, 8087], PROD),
      previewDomain: "hako.example.com",
      appOrigins: ["https://hako.example.com"],
    },
  );
  assert.deepEqual(headers, [
    ["Location", "https://myapp.hako.example.com/next"],
    ["Access-Control-Allow-Origin", "https://myapp.hako.example.com"],
    ["Link", "<https://myapp--8087.hako.example.com/a.js>; rel=preload, </b.css>; rel=preload"],
    ["Refresh", "3; url=https://myapp--8087.hako.example.com/x"],
    ["Set-Cookie", "sid=1; Path=/; HttpOnly; Domain=hako.example.com"],
    ["Set-Cookie", "__Host-x=1; Path=/; Secure"],
    ["Content-Security-Policy", "default-src 'self'"],
    ["Content-Type", "text/html"],
    ["Content-Security-Policy", "frame-ancestors https://hako.example.com"],
  ]);
  assert.equal(rewriteSetCookie("a=b", "hako.localhost"), "a=b; Domain=hako.localhost");
});

const TAG = `<script src="/__hako/client.js?p=x&amp;v=1"></script>`;

test("the client script goes first in the head, or where a page without one still starts", () => {
  const inject = (page: string) =>
    injectClientScript(Buffer.from(page, "latin1"), TAG).toString("latin1");
  assert.equal(
    inject("<!doctype html><html><head><title>t</title></head></html>"),
    `<!doctype html><html><head>${TAG}<title>t</title></head></html>`,
  );
  assert.equal(
    inject(`<HTML lang="en"><HEAD data-x="1"><header>`),
    `<HTML lang="en"><HEAD data-x="1">${TAG}<header>`,
  );
  assert.equal(inject("<html><header>a</header>"), `<html>${TAG}<header>a</header>`);
  assert.equal(inject("<!DOCTYPE html>\n<p>hi"), `<!DOCTYPE html>${TAG}\n<p>hi`);
  assert.equal(inject("<p>hi"), `${TAG}<p>hi`);
  assert.equal(inject("\xef\xbb\xbf<p>hi"), `\xef\xbb\xbf${TAG}<p>hi`);
  // While the start of a page could still lead to a <head>, the decision waits.
  assert.equal(injectionPoint("<!doctype html><html><he", false), null);
  assert.equal(
    injectionPoint("<!doctype html><html><body>", false),
    "<!doctype html><html>".length,
  );
});

test("a page whose own policy would block the client script is left alone", () => {
  const origin = "https://myapp.hako.example.com";
  assert.equal(cspAllowsClientScript([], origin), true);
  assert.equal(cspAllowsClientScript(["img-src *"], origin), true);
  assert.equal(cspAllowsClientScript(["script-src 'self' 'unsafe-eval'"], origin), true);
  assert.equal(cspAllowsClientScript(["default-src https:"], origin), true);
  assert.equal(cspAllowsClientScript(["script-src https://*.hako.example.com"], origin), true);
  assert.equal(cspAllowsClientScript(["script-src 'nonce-abc'"], origin), false);
  assert.equal(
    cspAllowsClientScript(["script-src 'self' 'strict-dynamic' 'nonce-a'"], origin),
    false,
  );
  assert.equal(cspAllowsClientScript(["default-src 'none'"], origin), false);
  assert.equal(
    cspAllowsClientScript(["script-src-elem cdn.example.com; script-src 'self'"], origin),
    false,
  );
  assert.equal(cspAllowsClientScript(["script-src *", "script-src 'none'"], origin), false);
});

test("stream windows: a sender stops at 512 KiB in flight, a receiver acknowledges what it passed on", () => {
  const send = new SendWindow();
  assert.equal(send.room, 512 * 1024);
  send.sent(500 * 1024);
  assert.equal(send.room, 12 * 1024);
  assert.throws(() => send.sent(13 * 1024));
  assert.equal(send.acked(600 * 1024), false, "more than was in flight");
  assert.equal(send.acked(-1), false);
  assert.equal(send.acked(100 * 1024), true);
  assert.equal(send.room, 112 * 1024);

  const receive = new ReceiveWindow(512 * 1024, 32 * 1024);
  assert.equal(receive.received(512 * 1024), true);
  assert.equal(receive.received(1), false, "over the window");
  assert.equal(receive.passedOn(10 * 1024, false), 0, "waits for enough to acknowledge");
  assert.equal(receive.passedOn(30 * 1024, false), 40 * 1024);
  assert.equal(receive.passedOn(1, true), 1, "drained: acknowledged at once");
  assert.equal(receive.received(40 * 1024 + 1), true, "the acknowledged bytes are room again");
  assert.equal(receive.received(1), false);
});

test("previews live at the app's host or under it, never above it", () => {
  const at = (origin: string, domain?: string) =>
    previewAddressingFrom(domain === undefined ? {} : { PREVIEW_DOMAIN: domain }, origin);
  assert.deepEqual(at("https://hako.example.com"), {
    domain: "hako.example.com",
    scheme: "https:",
    port: "",
  });
  assert.deepEqual(at("http://hako.localhost:8790"), {
    domain: "hako.localhost",
    scheme: "http:",
    port: ":8790",
  });
  assert.equal(at("https://hako.example.com", "p.hako.example.com")?.domain, "p.hako.example.com");
  assert.throws(() => at("https://hako.example.com", "example.com"));
  assert.equal(at("http://127.0.0.1:8787"), null);
});
