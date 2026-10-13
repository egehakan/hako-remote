// The mock agent's files: a throwaway tree with one of everything the web client has to cope with,
// and the `fs.*` methods of docs/protocol.md served from it and from nowhere else.

import { spawnSync } from "node:child_process";
import {
  accessSync,
  chmodSync,
  closeSync,
  constants,
  ftruncateSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  type Stats,
  statSync,
  symlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { crc32, deflateSync } from "node:zlib";
import {
  compareEntries,
  IMAGE_LIMIT_BYTES,
  imageMime,
  isValidPath,
  LIST_LIMIT,
  TEXT_LIMIT_BYTES,
} from "../shared/files.ts";
import { TRANSFER_CHUNK_BYTES, TRANSFER_MAX_BYTES } from "../shared/transfers.ts";
import type {
  ErrorCode,
  FsEntry,
  FsListResult,
  FsReadResult,
  FsRoot,
  FsRootsResult,
  FsWriteResult,
  Window,
} from "../shared/protocol.ts";

export class FsFailure extends Error {
  readonly code: ErrorCode;

  constructor(code: ErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

// The fixture

type Rgba = [number, number, number, number];

function png(width: number, height: number, pixel: (x: number, y: number) => Rgba, level = 6) {
  const stride = width * 4 + 1;
  const raw = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) raw.set(pixel(x, y), y * stride + 1 + x * 4);
  }
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
    const frame = Buffer.alloc(8 + body.length);
    frame.writeUInt32BE(data.length, 0);
    body.copy(frame, 4);
    frame.writeUInt32BE(crc32(body), 4 + body.length);
    return frame;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 6, 0, 0, 0], 8);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw, { level })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function inside(polygon: number[][], x: number, y: number): boolean {
  let hit = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [xi, yi] = polygon[i];
    const [xj, yj] = polygon[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) hit = !hit;
  }
  return hit;
}

const BOX_FACES: { colour: Rgba; points: number[][] }[] = [
  {
    colour: [246, 201, 132, 255],
    points: [
      [512, 208],
      [762, 352],
      [512, 496],
      [262, 352],
    ],
  },
  {
    colour: [232, 146, 62, 255],
    points: [
      [262, 416],
      [512, 560],
      [512, 848],
      [262, 704],
    ],
  },
  {
    colour: [176, 92, 40, 255],
    points: [
      [512, 560],
      [762, 416],
      [762, 704],
      [512, 848],
    ],
  },
];

/** The Hako box on its ink background, drawn point by point. */
function boxPixel(x: number, y: number): Rgba {
  const px = 212 + x * 2;
  const py = 172 + y * 2;
  for (const face of BOX_FACES) if (inside(face.points, px, py)) return face.colour;
  return [12, 13, 17, 255];
}

const BOX_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="212 172 600 720">
  <!-- Nothing in here may run: the client shows an SVG as an image, never as markup. -->
  <script>document.title = "UNSAFE: a script in an SVG ran";</script>
  <rect x="212" y="172" width="600" height="720" fill="#0c0d11" onload="document.title='UNSAFE'"/>
  <polygon points="512,208 762,352 512,496 262,352" fill="#f6c984"/>
  <polygon points="262,416 512,560 512,848 262,704" fill="#e8923e"/>
  <polygon points="512,560 762,416 762,704 512,848" fill="#b05c28"/>
</svg>
`;

const TINY_GIF = "R0lGODlhAQABAIAAAOiSPgAAACH5BAAAAAAALAAAAAABAAEAAAICRAEAOw==";
const TINY_WEBP = "UklGRhoAAABXRUJQVlA4TA0AAAAvAAAAEAcQERGIiP4HAA==";

const README = `# hako-remote

A phone-first web app for the **Hako** terminal. This file is part of the mock agent's fixture, and
it holds one of everything the Markdown view has to draw.

## What works

- [x] Workspace list
- [x] Live terminal
- [ ] Source control

1. Start the relay
2. Start the mock agent
3. Open the app

| Method     | Kind | Notes                    |
| ---------- | ---- | ------------------------ |
| \`fs.list\`  | req  | directories first        |
| \`fs.write\` | req  | never creates a new file |

> The relay does not interpret what it carries.

\`\`\`ts
const answer: number = 6 * 7;
console.log(\`the answer is \${answer}\`);
\`\`\`

Links: [the protocol](docs/protocol.md), [the app](src/App.tsx), [a web page](https://example.com),
and ~~struck through~~ text. A picture: ![the box mark](docs/images/box.png)

## Things that must stay inert

<script>document.title = "UNSAFE: raw HTML ran";</script>
<img src="x" onerror="document.title='UNSAFE: an event handler ran'">

[a script link](javascript:document.title='UNSAFE')
`;

const SAMPLES: Record<string, string> = {
  "README.md": README,
  "package.json": `{
  "name": "hako-remote",
  "version": "0.1.0",
  "private": true,
  "scripts": { "dev": "vite", "test": "node --test" },
  "dependencies": { "hono": "^4.13.13", "ws": "^8.22.0" },
  "flags": [true, false, null, 42, 1.5e3]
}
`,
  "index.html": `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <title>Hako</title>
    <style>
      body { margin: 0; background: #0c0d11; }
    </style>
  </head>
  <body>
    <div id="root" data-state="idle"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
`,
  "config.yaml": `# Relay settings
server:
  port: 8787
  origins:
    - https://hako.example.com
    - http://localhost:5173
limits: { frame_bytes: 8388608, login_tries: 5 }
secure: true
motto: "one box, one account"
`,
  "Cargo.toml": `[package]
name = "hako"
version = "0.1.0"
edition = "2024"

[dependencies]
serde = { version = "1", features = ["derive"] }
tokio = { version = "1", features = ["full"] }

[profile.release]
lto = true
`,
  "schema.sql": `-- One account, and its sessions.
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL
);

SELECT email, COUNT(*) AS sessions
FROM users JOIN sessions ON sessions.user_id = users.id
WHERE sessions.expires_at > 1700000000
GROUP BY email
ORDER BY sessions DESC;
`,
  Dockerfile: `FROM node:24-slim
WORKDIR /app
COPY . .
CMD ["node", "server/index.ts"]
`,
  ".gitignore": "node_modules\ndist\n.env\n",
  ".env.example": "HAKO_OWNER_EMAIL=you@example.com\nPORT=8787\n",
  "src/App.tsx": `import { useEffect, useState } from "react";

type Auth = { state: "checking" } | { state: "signed-in"; email: string };

// Decides between the login screen and the app.
export function App({ title = "Hako" }: { title?: string }) {
  const [auth, setAuth] = useState<Auth>({ state: "checking" });

  useEffect(() => {
    void fetch("/api/me").then(async (response) => {
      if (response.ok) setAuth({ state: "signed-in", email: (await response.json()).email });
    });
  }, []);

  return (
    <main className="app" data-count={3}>
      <h1>{title}</h1>
      {auth.state === "signed-in" ? <p>Signed in as {auth.email}</p> : <p>Checking…</p>}
    </main>
  );
}
`,
  "src/relay.ts": `export const PING_INTERVAL_MS = 25_000;

export class RpcFailure extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

/** Sends one request and waits for its answer. */
export async function request<T>(socket: WebSocket, method: string, params = {}): Promise<T> {
  const id = crypto.randomUUID();
  socket.send(JSON.stringify({ t: "req", id, method, params }));
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new RpcFailure("timeout", \`No answer to \${method}\`)), 20_000);
    socket.addEventListener("message", function listen(event) {
      const frame = JSON.parse(String(event.data));
      if (frame.id !== id) return;
      clearTimeout(timer);
      socket.removeEventListener("message", listen);
      frame.ok ? resolve(frame.result as T) : reject(new RpcFailure(frame.error.code, frame.error.message));
    });
  });
}
`,
  "src/index.css": `:root {
  --amber: #e8923e;
  --background: #0c0d11;
}

@media (min-width: 48rem) {
  .app > h1:hover {
    color: var(--amber);
    font: 600 1.25rem/1.4 "Schibsted Grotesk", sans-serif;
  }
}
`,
  "samples/script.js": `// Counts the words of a string.
function countWords(text) {
  const words = text.trim().split(/\\s+/).filter(Boolean);
  return words.length > 0 ? words.length : 0;
}

module.exports = { countWords, limit: 0x10, pattern: /^[a-z]+$/i };
`,
  "samples/component.jsx": `export function Badge({ label, tone = "quiet" }) {
  return (
    <span className={\`badge badge-\${tone}\`} title={label}>
      {label.toUpperCase()}
    </span>
  );
}
`,
  "samples/app.py": `"""A tiny HTTP health check."""
from dataclasses import dataclass
import urllib.request


@dataclass
class Result:
    url: str
    ok: bool


def check(url: str, timeout: float = 2.5) -> Result:
    # Anything below 400 counts as healthy.
    try:
        with urllib.request.urlopen(url, timeout=timeout) as response:
            return Result(url, response.status < 400)
    except OSError:
        return Result(url, False)


if __name__ == "__main__":
    print(f"{check('https://example.com')!r}")
`,
  "samples/main.rs": `use std::collections::HashMap;

#[derive(Debug, Clone)]
struct Folder {
    name: String,
    tabs: Vec<u32>,
}

/// Groups tab ids by the folder they sit in.
fn group(folders: &[Folder]) -> HashMap<&str, usize> {
    folders.iter().map(|f| (f.name.as_str(), f.tabs.len())).collect()
}

fn main() {
    let folders = vec![Folder { name: "hako".into(), tabs: vec![1, 2, 3] }];
    for (name, count) in group(&folders) {
        println!("{name}: {count} tabs");
    }
}
`,
  "samples/main.go": `package main

import (
	"fmt"
	"strings"
)

// Greeter says hello.
type Greeter struct{ Name string }

func (g Greeter) Greet() string {
	return fmt.Sprintf("hello, %s", strings.ToUpper(g.Name))
}

func main() {
	for i := 0; i < 3; i++ {
		fmt.Println(Greeter{Name: "hako"}.Greet(), i)
	}
}
`,
  "samples/deploy.sh": `#!/usr/bin/env bash
set -euo pipefail

# Builds and ships the relay.
TARGET="\${1:-production}"
if [[ "$TARGET" == "production" ]]; then
  echo "Deploying to $TARGET"
fi
for file in dist/*.js; do
  gzip -c "$file" | wc -c
done
`,
  "samples/View.swift": `import SwiftUI

struct TabRow: View {
    let title: String
    @State private var isFront = false

    var body: some View {
        HStack {
            Text(title).font(.headline)
            if isFront { Image(systemName: "circle.fill") }
        }
        .onTapGesture { isFront.toggle() }
    }
}
`,
  "samples/Main.java": `package com.example.hako;

import java.util.List;

public class Main {
    private static final int LIMIT = 5;

    /** Prints the first few names. */
    public static void main(String[] args) {
        List<String> names = List.of("relay", "agent", "client");
        for (String name : names.subList(0, Math.min(LIMIT, names.size()))) {
            System.out.println("hello, " + name);
        }
    }
}
`,
  "samples/frame.c": `#include <stdint.h>
#include <stdio.h>

#define FRAME_OUTPUT 0x01

/* Reads the big-endian offset of an output frame. */
static uint64_t read_seq(const uint8_t *bytes) {
    uint64_t seq = 0;
    for (int i = 0; i < 8; i++) seq = (seq << 8) | bytes[i];
    return seq;
}

int main(void) {
    const uint8_t header[8] = {0, 0, 0, 0, 0, 0, 1, 0};
    printf("seq %llu\\n", (unsigned long long)read_seq(header));
    return 0;
}
`,
  "samples/vec.cpp": `#include <iostream>
#include <string>
#include <vector>

template <typename T>
class Stack {
public:
    void push(T value) { items_.push_back(std::move(value)); }
    bool empty() const { return items_.empty(); }

private:
    std::vector<T> items_;
};

int main() {
    Stack<std::string> stack;
    stack.push("hako");
    std::cout << (stack.empty() ? "empty" : "not empty") << '\\n';
}
`,
  "samples/notes.txt": `Plain text has no highlighting.

A paragraph that is one long line, which is what the soft-wrap switch is for: it runs on and on past the right edge of a phone until wrapping is turned on, and then it folds neatly at the edge of the screen instead of asking for a sideways scroll.
`,
  "samples/Makefile": "build:\n\tpnpm build\n\n.PHONY: build\n",
  "docs/protocol.md": "# Protocol\n\nSee [the README](../README.md) for how to run it.\n",
  "fixtures/conflict.txt":
    "The mock agent rewrites this file on `kill -USR2 <pid>`.\n\nEdit me, then make the mock rewrite me, then save.\n",
  "fixtures/windows-line-endings.txt": "first line\r\nsecond line\r\nthird line\r\n",
  "fixtures/empty.txt": "",
};

/** Builds the tree and returns its root, which the mock workspace uses as the home directory. */
export function createFixture(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "hako-mock-")));
  const write = (path: string, data: string | Buffer) => {
    const file = join(root, path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, data);
  };

  const project = "Documents/GitHub/hako-remote";
  for (const [path, text] of Object.entries(SAMPLES)) write(`${project}/${path}`, text);

  const box = png(300, 360, boxPixel);
  write(`${project}/docs/images/box.png`, box);
  write(`${project}/docs/images/box.svg`, BOX_SVG);
  write(
    `${project}/docs/images/wide-stripes.png`,
    png(2400, 400, (x, y) =>
      Math.floor((x + y) / 40) % 2 ? [232, 146, 62, 255] : [19, 21, 27, 255],
    ),
  );
  write(`${project}/docs/images/dot.gif`, Buffer.from(TINY_GIF, "base64"));
  write(`${project}/docs/images/dot.webp`, Buffer.from(TINY_WEBP, "base64"));
  // macOS can turn the PNG into a real photograph format; elsewhere the fixture goes without one.
  const jpeg = join(root, project, "docs/images/box.jpg");
  spawnSync("sips", [
    "-s",
    "format",
    "jpeg",
    join(root, project, "docs/images/box.png"),
    "--out",
    jpeg,
  ]);

  write(
    `${project}/samples/long.ts`,
    Array.from(
      { length: 3000 },
      (_, index) => `export const value${index} = ${index} * 2; // line ${index + 1}`,
    ).join("\n") + "\n",
  );
  write(
    `${project}/samples/minified.js`,
    `${Array.from({ length: 400 }, (_, index) => `function f${index}(a,b){return a+b*${index}}`).join(";")}\n`,
  );

  const line = "2026-10-13T09:41:07Z relay INFO forwarded term.input to the agent (41 bytes)\n";
  write(
    `${project}/fixtures/too-large.log`,
    line.repeat(Math.ceil((TEXT_LIMIT_BYTES * 1.2) / line.length)),
  );
  const noise = Buffer.from(Array.from({ length: 4096 }, (_, index) => (index * 37 + 11) % 256));
  write(`${project}/fixtures/data.bin`, noise);
  write(`${project}/fixtures/latin1.txt`, Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a]));
  let seed = 7;
  const random = (): Rgba => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return [seed & 255, (seed >> 8) & 255, (seed >> 16) & 255, 255];
  };
  write(`${project}/fixtures/too-large.png`, png(1400, 1000, random, 0));
  write(
    `${project}/fixtures/read-only.txt`,
    "This file is read-only on the Mac. Saving it fails.\n",
  );
  chmodSync(join(root, project, "fixtures/read-only.txt"), 0o444);
  mkdirSync(join(root, project, "fixtures/no-entry"));
  chmodSync(join(root, project, "fixtures/no-entry"), 0o000);
  symlinkSync("../docs", join(root, project, "fixtures/link-to-docs"));
  symlinkSync("../README.md", join(root, project, "fixtures/link-to-readme.md"));
  symlinkSync("nowhere", join(root, project, "fixtures/broken-link"));
  symlinkSync("/etc", join(root, project, "fixtures/link-outside"));

  for (let index = 1; index <= 40; index++) {
    mkdirSync(join(root, project, "fixtures/many", `group-${String(index).padStart(2, "0")}`), {
      recursive: true,
    });
  }
  for (let index = 1; index <= 4960; index++) {
    writeFileSync(
      join(root, project, "fixtures/many", `item-${String(index).padStart(4, "0")}.json`),
      `{"id":${index}}\n`,
    );
  }

  write("Documents/GitHub/hako/README.md", "# hako\n\nA personal terminal.\n");
  write("Documents/GitHub/hako/Cargo.toml", SAMPLES["Cargo.toml"]);
  write("Documents/GitHub/hako/app/src/main.rs", SAMPLES["samples/main.rs"]);
  write("Documents/GitHub/hako/app/src/workspace/tab_folders.rs", "pub struct TabFolders;\n");
  write("Documents/GitHub/egehakan.com/index.html", SAMPLES["index.html"]);
  write("Documents/GitHub/egehakan.com/style.css", SAMPLES["src/index.css"]);
  write("Notes/todo.md", "# To do\n\n- [ ] Files on the phone\n- [x] Terminals on the phone\n");
  write("Notes/ideas.md", "# Ideas\n\nA box for every project.\n");
  mkdirSync(join(root, "Downloads"));
  createTransferFixture(join(root, "Downloads"));
  return root;
}

/** A file of `size` bytes that takes no time to make: nothing but its last bytes is written. */
function sparseFile(path: string, size: number): void {
  const mark = Buffer.from("the end\n");
  const file = openSync(path, "w");
  try {
    ftruncateSync(file, size);
    writeSync(file, mark, 0, mark.length, size - mark.length);
  } finally {
    closeSync(file);
  }
}

function patternedBytes(size: number, seed: number): Buffer {
  const bytes = Buffer.alloc(size);
  let state = seed;
  for (let index = 0; index < size; index++) {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    bytes[index] = state >> 16;
  }
  return bytes;
}

const CHANGING_FILE = "changes-while-read.bin";
const CHANGING_FILE_BYTES = 4 * TRANSFER_CHUNK_BYTES;

/**
 * What moving files needs to be tried against: files of several pieces, one at the limit and one
 * over it, a name to collide with, and a folder nothing can be written into. They live outside
 * the repositories of the fixture, where files of this size would slow git down.
 */
function createTransferFixture(directory: string): void {
  writeFileSync(join(directory, "notes.txt"), "Upload another notes.txt here to be asked.\n");
  writeFileSync(join(directory, "box.png"), png(300, 360, boxPixel));
  writeFileSync(
    join(directory, "five-megabytes.bin"),
    patternedBytes(5 * TRANSFER_CHUNK_BYTES + 321, 11),
  );
  writeFileSync(join(directory, CHANGING_FILE), patternedBytes(CHANGING_FILE_BYTES, 23));
  sparseFile(join(directory, "fifty-megabytes.bin"), TRANSFER_MAX_BYTES);
  sparseFile(join(directory, "over-the-limit.bin"), TRANSFER_MAX_BYTES + 1);
  mkdirSync(join(directory, "read-only-folder"));
  chmodSync(join(directory, "read-only-folder"), 0o555);
}

/** Changes a file of several pieces behind the client's back, as a build on the Mac would. */
export function rewriteChangingFile(root: string): string {
  const file = join(root, "Downloads", CHANGING_FILE);
  writeFileSync(file, patternedBytes(CHANGING_FILE_BYTES, Date.now() & 0xffff));
  return file;
}

export function removeFixture(root: string): void {
  try {
    chmodSync(join(root, "Documents/GitHub/hako-remote/fixtures/no-entry"), 0o755);
  } catch {
    // Already gone.
  }
  try {
    chmodSync(join(root, "Downloads/read-only-folder"), 0o755);
  } catch {
    // Already gone.
  }
  try {
    // A shell that is still exiting may write into the tree while it is being removed.
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch (error) {
    console.error(`could not remove ${root}: ${error instanceof Error ? error.message : error}`);
  }
}

/** Changes the conflict file behind the client's back, as an editor on the Mac would. */
export function rewriteConflictFile(root: string): string {
  const file = join(root, "Documents/GitHub/hako-remote/fixtures/conflict.txt");
  writeFileSync(file, `Rewritten on the Mac at ${new Date().toISOString()}.\n`);
  return file;
}

// The methods

export function failure(error: unknown, path: string): FsFailure {
  if (error instanceof FsFailure) return error;
  const code = (error as NodeJS.ErrnoException).code;
  if (code === "ENOENT" || code === "ENOTDIR" || code === "ELOOP") {
    return new FsFailure("not_found", `Nothing at ${path}`);
  }
  if (code === "EACCES" || code === "EPERM") {
    return new FsFailure("permission_denied", `Permission denied: ${path}`);
  }
  return new FsFailure("failed", error instanceof Error ? error.message : "Failed");
}

export const mtimeOf = (stats: Stats) => Math.floor(stats.mtimeMs);

/** The real location of a path, which has to be inside the fixture. */
export function resolveInFixture(root: string, path: unknown): string {
  if (!isValidPath(path)) {
    throw new FsFailure("bad_request", "path must be an absolute, normalised path");
  }
  let real: string;
  try {
    real = realpathSync(path);
  } catch (error) {
    throw failure(error, path);
  }
  if (real !== root && !real.startsWith(`${root}/`)) {
    throw new FsFailure(
      "permission_denied",
      `The mock agent serves only its fixture directory, and ${path} is outside it.`,
    );
  }
  return real;
}

export function createFsMethods(root: string, windows: () => Window[]) {
  const resolve = (path: unknown) => resolveInFixture(root, path);

  function entry(directory: string, name: string): FsEntry {
    const path = join(directory, name);
    try {
      const own = lstatSync(path);
      if (own.isSymbolicLink()) {
        try {
          const target = statSync(path);
          return {
            name,
            kind: "symlink",
            target: target.isDirectory() ? "dir" : target.isFile() ? "file" : "other",
            size: target.isDirectory() ? 0 : target.size,
            mtime: mtimeOf(target),
          };
        } catch {
          return { name, kind: "symlink", target: null, size: 0, mtime: mtimeOf(own) };
        }
      }
      if (own.isDirectory())
        return { name, kind: "dir", target: null, size: 0, mtime: mtimeOf(own) };
      return {
        name,
        kind: own.isFile() ? "file" : "other",
        target: null,
        size: own.size,
        mtime: mtimeOf(own),
      };
    } catch {
      return { name, kind: "other", target: null, size: 0, mtime: 0 };
    }
  }

  return {
    "fs.roots": (): FsRootsResult => {
      const roots: FsRoot[] = [];
      const add = (candidate: FsRoot) => {
        if (!roots.some((existing) => existing.path === candidate.path)) roots.push(candidate);
      };
      for (const window of windows()) {
        for (const folder of window.folders) {
          add({ path: folder.directory, name: folder.name, source: "folder" });
        }
      }
      add({ path: root, name: "Home", source: "home" });
      for (const window of windows()) {
        for (const tab of window.tabs) {
          for (const pane of tab.panes) {
            if (pane.cwd === null) continue;
            const name = pane.cwd === "/" ? "/" : pane.cwd.slice(pane.cwd.lastIndexOf("/") + 1);
            add({ path: pane.cwd, name, source: "terminal" });
          }
        }
      }
      return { home: root, roots };
    },

    "fs.list": (params: Record<string, unknown>): FsListResult => {
      const directory = resolve(params.path);
      try {
        if (!statSync(directory).isDirectory()) {
          throw new FsFailure("not_a_directory", `${String(params.path)} is not a directory`);
        }
        const entries = readdirSync(directory)
          .map((name) => entry(directory, name))
          .sort(compareEntries);
        return { entries: entries.slice(0, LIST_LIMIT), truncated: entries.length > LIST_LIMIT };
      } catch (error) {
        throw failure(error, String(params.path));
      }
    },

    "fs.read": (params: Record<string, unknown>): FsReadResult => {
      const file = resolve(params.path);
      const path = String(params.path);
      try {
        const stats = statSync(file);
        if (stats.isDirectory()) throw new FsFailure("is_a_directory", `${path} is a directory`);
        if (!stats.isFile()) throw new FsFailure("failed", `${path} is not a regular file`);
        const mime = imageMime(path);
        if (mime !== null) {
          if (stats.size > IMAGE_LIMIT_BYTES) {
            return { kind: "too_large", size: stats.size, limit: IMAGE_LIMIT_BYTES };
          }
          const bytes = readFileSync(file);
          return {
            kind: "image",
            mime,
            data: bytes.toString("base64"),
            mtime: mtimeOf(stats),
            size: bytes.length,
          };
        }
        if (stats.size > TEXT_LIMIT_BYTES) {
          return { kind: "too_large", size: stats.size, limit: TEXT_LIMIT_BYTES };
        }
        const bytes = readFileSync(file);
        if (bytes.includes(0)) return { kind: "binary", size: bytes.length };
        let content: string;
        try {
          content = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
        } catch {
          return { kind: "binary", size: bytes.length };
        }
        return { kind: "text", content, mtime: mtimeOf(stats), size: bytes.length };
      } catch (error) {
        throw failure(error, path);
      }
    },

    "fs.write": (params: Record<string, unknown>): FsWriteResult => {
      const { content, expected_mtime: expected } = params;
      if (typeof content !== "string")
        throw new FsFailure("bad_request", "content must be a string");
      if (expected !== null && typeof expected !== "number") {
        throw new FsFailure("bad_request", "expected_mtime must be a number or null");
      }
      const file = resolve(params.path);
      const path = String(params.path);
      const bytes = Buffer.from(content, "utf8");
      if (bytes.length > TEXT_LIMIT_BYTES) {
        throw new FsFailure("too_large", `The text is over the limit of ${TEXT_LIMIT_BYTES} bytes`);
      }
      try {
        const stats = statSync(file);
        if (stats.isDirectory()) throw new FsFailure("is_a_directory", `${path} is a directory`);
        if (!stats.isFile()) throw new FsFailure("failed", `${path} is not a regular file`);
        if (expected !== null && expected !== mtimeOf(stats)) {
          throw new FsFailure("conflict", `${path} changed on the Mac since it was read`);
        }
        accessSync(file, constants.W_OK);
        const temporary = join(dirname(file), `.hako-write-${process.pid}-${Date.now()}`);
        try {
          writeFileSync(temporary, bytes, { mode: stats.mode & 0o777 });
          renameSync(temporary, file);
        } catch (error) {
          rmSync(temporary, { force: true });
          throw error;
        }
        return { mtime: mtimeOf(statSync(file)), size: bytes.length };
      } catch (error) {
        throw failure(error, path);
      }
    },
  };
}
