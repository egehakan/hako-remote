// Small dev servers the mock agent runs as previews, each built to try one thing the relay must get
// right when it tunnels a preview. Run by the mock agent; by hand:
//
//   node scripts/mock-preview-server.ts site <port>
//     A page that refuses to be framed and logs an error, a WebSocket echo, server-sent events, a
//     redirect to its own localhost address, a cookie for Domain=localhost, the request headers as
//     the server saw them, a download of any size and an upload counter.
//
//   node scripts/mock-preview-server.ts lab <port>
//     Everything the Mac browser has to carry: links, a long page, a form, a new tab and a pop-up,
//     alert, confirm and prompt, a select, date, time and colour inputs, a file input, a download,
//     text to copy, and console errors and failed requests.
//
//   node scripts/mock-preview-server.ts two-port <web port> <api port>
//     A page on one port that uses an API on another, by its localhost address, as a web app and its
//     API server do on a Mac: fetch with credentials, an image, a WebSocket, and a sign-in cookie set
//     by the API and read on the page's own server. The API checks the Origin and answers CORS.

import http, { type IncomingMessage, type ServerResponse } from "node:http";
import { WebSocketServer } from "ws";

const [mode, first, second] = process.argv.slice(2);

function html(res: ServerResponse, body: string, headers: Record<string, string> = {}): void {
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", ...headers });
  res.end(body);
}

function page(title: string, body: string, script = ""): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>
body{font:16px/1.5 system-ui,sans-serif;margin:0;padding:16px;background:#fbf7f0;color:#222}
h1{font-size:20px;margin:0 0 8px} code,pre{font:13px ui-monospace,monospace}
pre{background:#fff;border:1px solid #ddd;padding:8px;white-space:pre-wrap;word-break:break-all}
a{color:#b5591a} button{font:inherit;padding:6px 12px}
#width{font-weight:600}
</style>
</head>
<body>
${body}
<script>${script}</script>
</body>
</html>`;
}

function readCookies(req: IncomingMessage): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const eq = part.indexOf("=");
    if (eq > 0) out[part.slice(0, eq).trim()] = part.slice(eq + 1).trim();
  }
  return out;
}

function site(port: number): void {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", `http://localhost:${port}`);
    switch (url.pathname) {
      case "/":
        html(
          res,
          page(
            "Demo site",
            `<h1>Demo site on port ${port}</h1>
<p>Width as this page sees it: <span id="width"></span> CSS px.</p>
<p><a href="/redirect">Redirect to http://localhost:${port}/x</a> ·
<a href="/cookie">Set a cookie for Domain=localhost</a> · <a href="/headers">Request headers</a> ·
<a href="/big?mb=50">Download 50 MB</a> · <a href="/?again=1#top">This page again</a></p>
<p><button id="send">Send over the WebSocket</button> <span id="echo">not connected</span></p>
<p>Server-sent events: <span id="events">waiting</span></p>
<form method="post" action="/upload" enctype="text/plain"><input name="text" value="hello"> <button>Post</button></form>`,
            `
const show = () => { document.getElementById("width").textContent = innerWidth + " × " + innerHeight; };
show(); addEventListener("resize", show);
const ws = new WebSocket("ws://localhost:${port}/echo");
ws.onopen = () => { document.getElementById("echo").textContent = "connected"; };
ws.onmessage = (e) => { document.getElementById("echo").textContent = "echo: " + e.data; };
document.getElementById("send").onclick = () => ws.send("ping " + new Date().toLocaleTimeString());
const events = new EventSource("/events");
events.onmessage = (e) => { document.getElementById("events").textContent = e.data; };
addEventListener("load", () => {
  console.error("demo: an error logged on load");
  console.warn("demo: a warning logged on load");
});
`,
          ),
          { "X-Frame-Options": "DENY", "Content-Security-Policy": "frame-ancestors 'none'" },
        );
        return;
      case "/x":
        html(res, page("Landed", `<h1>You landed on /x</h1><p><a href="/">Back</a></p>`));
        return;
      case "/redirect":
        res.writeHead(302, { Location: `http://localhost:${port}/x` });
        res.end();
        return;
      case "/cookie":
        res.writeHead(200, {
          "Content-Type": "text/html; charset=utf-8",
          "Set-Cookie": `demo=${Date.now()}; Domain=localhost; Path=/; SameSite=Lax`,
        });
        res.end(
          page(
            "Cookie",
            `<h1>Cookie set</h1><p>The request brought: <code>${escape(req.headers.cookie ?? "(none)")}</code></p><p><a href="/cookie">Again</a> · <a href="/">Back</a></p>`,
          ),
        );
        return;
      case "/headers":
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(req.headers, null, 2));
        return;
      case "/events": {
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
        });
        let count = 0;
        const tick = () => res.write(`data: event ${++count} at ${new Date().toISOString()}\n\n`);
        tick();
        const timer = setInterval(tick, 1000);
        req.on("close", () => clearInterval(timer));
        return;
      }
      case "/big": {
        const total = Math.min(Number(url.searchParams.get("mb") ?? 50), 500) * 1024 * 1024;
        res.writeHead(200, {
          "Content-Type": "application/octet-stream",
          "Content-Length": String(total),
          "Content-Disposition": 'attachment; filename="big.bin"',
        });
        const chunk = Buffer.alloc(256 * 1024, 0x61);
        let sent = 0;
        const pump = () => {
          while (sent < total) {
            const piece = chunk.subarray(0, Math.min(chunk.length, total - sent));
            sent += piece.length;
            if (!res.write(piece)) {
              res.once("drain", pump);
              return;
            }
          }
          res.end();
        };
        pump();
        return;
      }
      case "/upload": {
        let bytes = 0;
        req.on("data", (chunk: Buffer) => {
          bytes += chunk.length;
        });
        req.on("end", () => {
          res.writeHead(200, { "Content-Type": "text/plain" });
          res.end(`received ${bytes} bytes via ${req.method}\n`);
        });
        return;
      }
      default:
        res.writeHead(404, { "Content-Type": "text/plain" });
        res.end("not found\n");
    }
  });
  const wss = new WebSocketServer({ server, path: "/echo" });
  wss.on("connection", (socket) => socket.on("message", (data) => socket.send(String(data))));
  server.listen(port, "127.0.0.1", () => console.log(`demo site on http://localhost:${port}`));
}

function lab(port: number): void {
  const home = `<h1>Browser lab</h1>
<p id="intro">Each part below tries one thing the Mac browser has to carry to the phone. Select this
sentence and copy it.</p>
<h2>Pages</h2>
<p><a id="to-long" href="/long">A long page</a> · <a id="to-form" href="/form">A form</a> ·
<a id="new-tab" href="/tab" target="_blank">Open in a new tab</a> ·
<button id="popup">Open a pop-up</button> <span id="popup-result"></span></p>
<h2>Dialogs</h2>
<p><button id="alert">Alert</button> <button id="confirm">Confirm</button>
<button id="prompt">Prompt</button></p>
<pre id="dialog-result">no dialog yet</pre>
<h2>Pickers</h2>
<p><label>Fruit <select id="fruit"><option value="apple">Apple</option><option value="pear" selected>Pear</option>
<optgroup label="Citrus"><option value="lemon">Lemon</option><option value="lime" disabled>Lime</option></optgroup></select></label></p>
<p><label>Toppings <select id="toppings" multiple><option value="nuts">Nuts</option><option value="cream" selected>Cream</option><option value="honey">Honey</option></select></label></p>
<p><label>Date <input id="date" type="date" value="2026-10-14"></label>
<label>Time <input id="time" type="time" value="09:30"></label>
<label>Colour <input id="color" type="color" value="#e8923e"></label></p>
<pre id="picker-result">nothing chosen yet</pre>
<h2>Files</h2>
<form method="post" action="/upload" enctype="multipart/form-data">
<input id="files" type="file" name="files" multiple accept="image/*,.txt,.pdf">
<button>Upload</button></form>
<pre id="file-result">no files chosen</pre>
<p><a id="download" href="/download/report.txt">Download report.txt</a> ·
<a id="download-slow" href="/download/slow.bin">A slow download</a> ·
<a id="download-broken" href="/download/broken.bin">One that breaks</a> ·
<a id="download-cancel" href="/download/cancel-me.bin">One cancelled on the Mac</a></p>
<h2>Console</h2>
<p><button id="log-error">Log an error</button> <button id="throw">Throw</button>
<button id="fetch-missing">Fetch a missing file</button></p>
<p><input id="typing" placeholder="Type here" style="width:90%"></p>
<pre id="typed"></pre>
<img src="/missing.png" alt="" width="1" height="1">`;
  const homeScript = `
const show = (id, text) => { document.getElementById(id).textContent = text; };
document.getElementById("popup").onclick = () => window.open("/popup", "lab-popup", "width=420,height=520");
document.getElementById("alert").onclick = () => { alert("Hello from the lab"); show("dialog-result", "alert closed"); };
document.getElementById("confirm").onclick = () => show("dialog-result", "confirm: " + confirm("Go ahead?"));
document.getElementById("prompt").onclick = () => show("dialog-result", "prompt: " + JSON.stringify(prompt("Your name?", "Ada")));
const pickers = () => show("picker-result", [
  "fruit=" + document.getElementById("fruit").value,
  "toppings=" + [...document.getElementById("toppings").selectedOptions].map((o) => o.value).join("+"),
  "date=" + document.getElementById("date").value,
  "time=" + document.getElementById("time").value,
  "color=" + document.getElementById("color").value,
].join("\\n"));
for (const id of ["fruit", "toppings", "date", "time", "color"]) {
  document.getElementById(id).addEventListener("change", pickers);
}
document.getElementById("files").addEventListener("change", (e) => show("file-result",
  [...e.target.files].map((f) => f.name + " (" + f.size + " bytes)").join("\\n") || "no files chosen"));
document.getElementById("log-error").onclick = () => console.error("lab: an error logged on purpose");
document.getElementById("throw").onclick = () => setTimeout(() => { throw new Error("lab: thrown on purpose"); });
document.getElementById("fetch-missing").onclick = () => fetch("/missing.json");
document.getElementById("typing").addEventListener("input", (e) => show("typed", e.target.value));
console.warn("lab: a warning on load");
`;
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", `http://localhost:${port}`);
    switch (url.pathname) {
      case "/":
        html(res, page("Browser lab", home, homeScript));
        return;
      case "/long": {
        const rows = Array.from(
          { length: 150 },
          (_, i) => `<p id="row-${i + 1}">Row ${i + 1} of a long page.</p>`,
        ).join("\n");
        html(
          res,
          page(
            "A long page",
            `<h1>A long page</h1>${rows}<p><a id="bottom-link" href="/">Back to the lab</a></p>`,
          ),
        );
        return;
      }
      case "/form":
        if (req.method === "POST") {
          let body = "";
          req.on("data", (chunk: Buffer) => {
            body += chunk.toString("utf8");
          });
          req.on("end", () => {
            const fields = new URLSearchParams(body);
            const rows = [...fields].map(([k, v]) => `${escape(k)}: ${escape(v)}`).join("\n");
            html(
              res,
              page(
                "Sent",
                `<h1>The form arrived</h1><pre id="form-result">${rows}</pre><p><a href="/form">Again</a> · <a href="/">Lab</a></p>`,
              ),
            );
          });
          return;
        }
        html(
          res,
          page(
            "A form",
            `<h1>A form</h1><form method="post" action="/form">
<p><label>Name <input id="name" name="name" autocomplete="off"></label></p>
<p><label>Notes <textarea id="notes" name="notes" rows="3"></textarea></label></p>
<p><label><input id="agree" type="checkbox" name="agree" value="yes"> I agree</label></p>
<p><button id="submit">Send</button></p></form>`,
          ),
        );
        return;
      case "/tab":
        html(
          res,
          page(
            "A new tab",
            `<h1>This opened in a new tab</h1><p><button id="close" onclick="window.close()">Close this tab</button> · <a href="/long">Go to the long page</a></p>`,
          ),
        );
        return;
      case "/popup":
        html(
          res,
          page(
            "A pop-up",
            `<h1>A pop-up</h1><p><button id="answer">Answer and close</button></p>`,
            `document.getElementById("answer").onclick = () => {
  if (window.opener) window.opener.document.getElementById("popup-result").textContent =
    "the pop-up answered at " + new Date().toLocaleTimeString();
  window.close();
};`,
          ),
        );
        return;
      case "/download/report.txt":
        res.writeHead(200, {
          "Content-Type": "text/plain; charset=utf-8",
          "Content-Disposition": 'attachment; filename="report.txt"',
        });
        res.end(`A report from the browser lab, made at ${new Date().toISOString()}.\n`);
        return;
      case "/download/slow.bin":
      case "/download/broken.bin":
      case "/download/cancel-me.bin": {
        // Slow: 6 chunks a second apart, then done. Broken: two chunks, then the connection drops.
        // Cancel-me: ten minutes long; the mock agent cancels it, as the owner might on the Mac.
        const name = url.pathname.slice("/download/".length);
        const chunk = Buffer.alloc(64 * 1024, 0x61);
        const chunks = name === "cancel-me.bin" ? 600 : 6;
        res.writeHead(200, {
          "Content-Type": "application/octet-stream",
          "Content-Disposition": `attachment; filename="${name}"`,
          "Content-Length": String(chunk.length * chunks),
        });
        let sent = 0;
        const timer = setInterval(() => {
          if (name === "broken.bin" && sent === 2) {
            clearInterval(timer);
            res.destroy();
            return;
          }
          res.write(chunk);
          sent += 1;
          if (sent === chunks) {
            clearInterval(timer);
            res.end();
          }
        }, 1000);
        res.on("close", () => clearInterval(timer));
        return;
      }
      case "/upload": {
        const chunks: Buffer[] = [];
        req.on("data", (chunk: Buffer) => chunks.push(chunk));
        req.on("end", () => {
          const body = Buffer.concat(chunks).toString("latin1");
          const names = [...body.matchAll(/filename="([^"]*)"/g)].map((m) => m[1]);
          html(
            res,
            page(
              "Uploaded",
              `<h1>Upload arrived</h1><pre id="upload-result">${escape(names.join("\n") || "(no files)")}
${chunks.reduce((n, c) => n + c.length, 0)} bytes in all</pre><p><a href="/">Lab</a></p>`,
            ),
          );
        });
        return;
      }
      default:
        res.writeHead(404, { "Content-Type": "text/plain" });
        res.end("not found\n");
    }
  });
  server.listen(port, "127.0.0.1", () => console.log(`browser lab on http://localhost:${port}`));
}

function escape(text: string): string {
  return text.replace(/[&<>"]/g, (char) => `&#${char.charCodeAt(0)};`);
}

function twoPort(webPort: number, apiPort: number): void {
  const web = `http://localhost:${webPort}`;
  const api = `http://localhost:${apiPort}`;

  http
    .createServer((req, res) => {
      const url = new URL(req.url ?? "/", web);
      if (url.pathname !== "/") {
        res.writeHead(404);
        res.end();
        return;
      }
      // Read on this server, where the API set it: on a Mac cookies ignore the port.
      const signedIn = readCookies(req).api_session ?? null;
      html(
        res,
        page(
          "Two ports",
          `<h1>Web on ${webPort}, API on ${apiPort}</h1>
<p>Width: <span id="width"></span> CSS px</p>
<p>Page server saw the API's cookie: <b id="server-cookie">${signedIn ? "yes" : "no"}</b></p>
<p><button id="login">Sign in (API sets a cookie)</button> <button id="me">Who am I (fetch with credentials)</button></p>
<pre id="result">…</pre>
<p>Image from the API: <img id="img" src="${api}/img.png" width="24" height="24" alt="api image"></p>
<p>WebSocket to the API: <span id="ws">connecting</span></p>`,
          `
const show = () => { document.getElementById("width").textContent = innerWidth + " × " + innerHeight; };
show(); addEventListener("resize", show);
const out = (text) => { document.getElementById("result").textContent = text; };
document.getElementById("login").onclick = async () => {
  const r = await fetch("${api}/login", { method: "POST", credentials: "include" });
  out("login: " + r.status + " " + await r.text());
};
document.getElementById("me").onclick = async () => {
  try {
    const r = await fetch("${api}/me", { credentials: "include" });
    out("me: " + r.status + " " + await r.text());
  } catch (e) { out("me failed: " + e); }
};
const ws = new WebSocket("ws://localhost:${apiPort}/ws");
ws.onmessage = (e) => { document.getElementById("ws").textContent = e.data; };
ws.onerror = () => { document.getElementById("ws").textContent = "failed"; };
`,
        ),
      );
    })
    .listen(webPort, "127.0.0.1", () => console.log(`two-port web on ${web}`));

  const apiServer = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", api);
    const origin = req.headers.origin;
    const cors = {
      "Access-Control-Allow-Origin": web,
      "Access-Control-Allow-Credentials": "true",
      Vary: "Origin",
    };
    if (url.pathname === "/img.png") {
      // A 1×1 orange PNG.
      const png = Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==",
        "base64",
      );
      res.writeHead(200, { "Content-Type": "image/png", "Content-Length": png.length });
      res.end(png);
      return;
    }
    // The API takes requests from its own web app only, as a CORS list made for localhost does.
    if (origin !== web) {
      res.writeHead(403, { "Content-Type": "text/plain" });
      res.end(`origin ${origin ?? "(none)"} is not ${web}\n`);
      return;
    }
    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        ...cors,
        "Access-Control-Allow-Methods": "GET, POST",
        "Access-Control-Allow-Headers": "content-type",
      });
      res.end();
      return;
    }
    if (url.pathname === "/login" && req.method === "POST") {
      res.writeHead(200, {
        ...cors,
        "Content-Type": "text/plain",
        "Set-Cookie": `api_session=user-${Date.now()}; Path=/; HttpOnly; SameSite=Lax`,
      });
      res.end("signed in\n");
      return;
    }
    if (url.pathname === "/me") {
      const session = readCookies(req).api_session;
      res.writeHead(session ? 200 : 401, { ...cors, "Content-Type": "application/json" });
      res.end(JSON.stringify({ session: session ?? null, origin, host: req.headers.host }));
      return;
    }
    res.writeHead(404, cors);
    res.end();
  });
  const wss = new WebSocketServer({ noServer: true });
  apiServer.on("upgrade", (req, socket, head) => {
    if (req.headers.origin !== web || !req.url?.startsWith("/ws")) {
      socket.end("HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n");
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.send(`connected, origin ${req.headers.origin}`);
    });
  });
  apiServer.listen(apiPort, "127.0.0.1", () => console.log(`two-port api on ${api}`));
}

if (mode === "site") site(Number(first));
else if (mode === "two-port") twoPort(Number(first), Number(second));
else if (mode === "lab") lab(Number(first));
else {
  console.error(
    "usage: mock-preview-server.ts site <port> | lab <port> | two-port <web port> <api port>",
  );
  process.exit(2);
}
