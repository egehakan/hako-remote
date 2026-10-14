// The small pages a preview origin answers with when it cannot show the preview.

import type { ServerResponse } from "node:http";
import type { Duplex } from "node:stream";

export type PreviewPage = {
  status: number;
  title: string;
  text: string;
  link: string | null;
  /** Seconds after which the page loads itself again. */
  refresh?: number;
};

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
}

export function renderPage(page: PreviewPage): string {
  const link =
    page.link === null
      ? ""
      : `<p><a href="${escapeHtml(page.link)}" target="_top">Open Hako</a></p>`;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex">${page.refresh ? `<meta http-equiv="refresh" content="${page.refresh}">` : ""}
<title>${escapeHtml(page.title)}</title>
<style>
:root{color-scheme:light dark;font-family:ui-sans-serif,system-ui,-apple-system,sans-serif}
body{margin:0;min-height:100vh;display:grid;place-items:center;background:Canvas;color:CanvasText}
main{max-width:22rem;padding:1.5rem;text-align:center}
h1{font-size:1.125rem;margin:0 0 .5rem}
p{margin:.5rem 0;line-height:1.45;opacity:.75}
a{color:#d97a1f}
</style></head>
<body><main><h1>${escapeHtml(page.title)}</h1><p>${escapeHtml(page.text)}</p>${link}</main></body></html>
`;
}

function headersFor(body: string, appOrigins: readonly string[]): Record<string, string> {
  return {
    "Content-Type": "text/html; charset=utf-8",
    "Content-Length": String(Buffer.byteLength(body)),
    "Cache-Control": "no-store",
    "Content-Security-Policy": `default-src 'none'; style-src 'unsafe-inline'; frame-ancestors ${appOrigins.join(" ")}`,
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
  };
}

export function sendPage(res: ServerResponse, page: PreviewPage, appOrigins: readonly string[]) {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  const body = renderPage(page);
  res.writeHead(page.status, headersFor(body, appOrigins));
  res.end(res.req.method === "HEAD" ? undefined : body);
}

/** The same page as the answer to a WebSocket handshake, written on the raw socket. */
export function sendPageOnSocket(socket: Duplex, page: PreviewPage, appOrigins: readonly string[]) {
  const body = renderPage(page);
  const headers = { ...headersFor(body, appOrigins), Connection: "close" };
  const head = Object.entries(headers)
    .map(([name, value]) => `${name}: ${value}`)
    .join("\r\n");
  const reason = { 401: "Unauthorized", 404: "Not Found", 503: "Service Unavailable" }[page.status];
  socket.end(`HTTP/1.1 ${page.status} ${reason ?? "Error"}\r\n${head}\r\n\r\n${body}`);
}

export const pages = {
  notFound: (label: string, appUrl: string): PreviewPage => ({
    status: 404,
    title: `No preview called ${label}`,
    text: "Hako has no preview by this name. Start it from Claude Code on your Mac, or pick one under Previews.",
    link: `${appUrl}/#/previews`,
  }),
  noPort: (label: string, port: number, appUrl: string): PreviewPage => ({
    status: 404,
    title: `No port ${port} in ${label}`,
    text: "This preview does not list that port.",
    link: `${appUrl}/#/previews`,
  }),
  unauthorized: (appUrl: string, used = false): PreviewPage => ({
    status: 401,
    title: "Open this preview from Hako",
    text: used
      ? "This link has been used or has expired. Open the preview again from Previews in Hako."
      : "Previews open only for you. Open it from Previews in Hako, where you are signed in.",
    link: `${appUrl}/#/previews`,
  }),
  offline: (): PreviewPage => ({
    status: 503,
    title: "Your Mac is offline",
    text: "Hako on your Mac is not connected, so this preview cannot be reached. It comes back when the Mac does.",
    link: null,
  }),
  stopped: (message: string | null): PreviewPage => ({
    status: 503,
    title: "This preview is stopped",
    text: message ?? "Its dev server is not running. Restart it from Previews in Hako.",
    link: null,
  }),
  starting: (): PreviewPage => ({
    status: 503,
    title: "This preview is starting",
    text: "Its dev server is not answering yet. This page tries again in a moment.",
    link: null,
    refresh: 3,
  }),
  unreachable: (port: number, message: string): PreviewPage => ({
    status: 503,
    title: `Nothing answers on port ${port}`,
    text: message,
    link: null,
  }),
  busy: (): PreviewPage => ({
    status: 503,
    title: "Too many connections",
    text: "This preview has as many connections open as the relay allows. Try again in a moment.",
    link: null,
  }),
  tooLarge: (): PreviewPage => ({
    status: 413,
    title: "Too large",
    text: "A request to a preview may carry at most 50 MB.",
    link: null,
  }),
};
