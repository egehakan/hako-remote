# Hako remote protocol (v1)

Three parties:

- **Agent**: the Hako desktop app on the Mac. It dials out to the relay and never listens on the network.
- **Relay**: the server in this repo. It authenticates both sides and passes messages between them.
- **Client**: the web app in a browser.

The relay does not interpret workspace, file or git data. It routes requests to the agent, routes
responses back to the client that asked, and fans events out to clients. It forwards any method name
without knowing it; the only methods it reads are `app.info` (which it calls itself, see
[Relay events](#relay-events)) and `term.subscribe` / `term.unsubscribe` (to route terminal output).

## Connections

| Path | Who | Auth |
|---|---|---|
| `GET /ws/agent` | Agent | `Authorization: Bearer <agent key>`. One agent at a time; a new connection replaces the old one. |
| `GET /ws/client` | Client | Session cookie from `POST /api/login`, and an `Origin` header equal to the app's own origin. |

A connection that fails these checks is refused during the HTTP upgrade, before any WebSocket
exists: `401` for a missing or wrong agent key or session cookie, `403` for a missing or foreign
`Origin`.

Keeping connections alive:

- The relay and the agent each send a WebSocket ping frame every 25 seconds and drop the connection
  after 60 seconds without receiving any frame (pings and pongs count). The agent reconnects with
  backoff (1 s doubling to 30 s).
- A browser can neither send nor see WebSocket ping frames. The relay pings the client the same way
  (the browser answers by itself) and drops it after 60 seconds of silence. For its own check the
  client sends the text frame `{ "t": "ping" }` every 25 seconds and the relay answers
  `{ "t": "pong" }`; a client that has received nothing for 60 seconds closes and reconnects. The
  relay answers `{ "t": "ping" }` from the agent too, but the agent does not need it.
- The client reconnects on close and on `visibilitychange`.

Close codes the relay uses:

| Code | Sent to | Meaning |
|---|---|---|
| `4001` | Agent | Replaced by a newer agent connection. Wait 30 seconds before reconnecting, so two running apps do not take the slot from each other in a loop. |
| `4401` | Client | The login session ended (logout, password change elsewhere, or expiry). Log in again. |

A text or binary frame larger than 8 MB closes the connection.

## HTTP API (relay only)

| Method and path | Body | Result |
|---|---|---|
| `GET /api/health` | | `{ ok: true }` |
| `POST /api/login` | `{ email, password }` | `{ email }`, and sets the session cookie (HttpOnly, Secure, SameSite=Lax, 30 days). Five failures block further tries for 15 minutes. |
| `POST /api/logout` | | `{ ok: true }`. Ends the session and clears the cookie. |
| `GET /api/me` | | `{ email }` or 401 |
| `POST /api/password` | `{ current, next }` | `{ ok: true }`. Changes the password and ends other sessions. `next` is 10 to 256 characters. |

Bodies are JSON. A `POST` whose `Origin` header is not the app's own origin gets `403`. Errors are
`{ error, ... }` with these statuses:

| Status | Body | When |
|---|---|---|
| 400 | `{ error: "bad_request" }` | A field is missing or not a string. |
| 400 | `{ error: "weak_password", message }` | `next` is too short or too long. |
| 401 | `{ error: "invalid_credentials", remaining }` | Wrong email or password at login. `remaining` is the number of tries left. |
| 401 | `{ error: "unauthorized" }` | No valid session. |
| 403 | `{ error: "invalid_credentials", remaining }` | Wrong `current` password at `/api/password`. |
| 429 | `{ error: "locked", retry_after }` | Blocked after five failures; `retry_after` is in seconds, also sent as `Retry-After`. |

Failures are counted per email address (the one account's address for `/api/password`). The fifth
failure itself answers `429`, and while the block lasts even the right password is refused. Without
HTTPS (local development) the cookie is set without `Secure`.

## Frames

Text frames are JSON. Binary frames carry terminal output only.

```jsonc
// request: client -> relay -> agent
{ "t": "req", "id": "7", "method": "workspace.list", "params": {} }

// response: agent -> relay -> the client that asked
{ "t": "res", "id": "7", "ok": true, "result": {} }
{ "t": "res", "id": "7", "ok": false, "error": { "code": "not_found", "message": "No such tab" } }

// notification: client -> relay -> agent, no response
{ "t": "ntf", "method": "term.input", "params": { "session_id": "…", "data": "ls\r" } }

// event: agent -> relay -> clients, or relay -> clients
{ "t": "evt", "event": "workspace.changed", "data": {} }
```

Request ids are opaque strings to the agent, which echoes them back unchanged. The relay rewrites a
client's id to `<connection id>:<client id>` on the way to the agent and restores it on the way back,
so ids from different clients cannot collide. A client id is a non-empty string of at most 128
characters, unique among that connection's unanswered requests; anything else fails with
`bad_request`. `params` may be left out, and the agent then receives `{}`. A request with no response
in 20 seconds fails at the relay with `timeout`; a response that arrives later is dropped. When the
agent is offline every request fails at once with `agent_offline`, and requests in flight when the
agent drops fail the same way. Notifications sent while the agent is offline are dropped.

The relay also sends the agent requests of its own. Their ids start with `relay:` and the agent
answers them like any other request.

Error codes: `agent_offline`, `timeout`, `bad_request`, `not_found`, `not_supported`, `failed`.

### Terminal output frame (binary, agent -> relay -> subscribed clients)

```
byte 0        0x01
byte 1        n = length of the session id in bytes (1 to 255)
bytes 2..2+n  session id, UTF-8
next 8 bytes  seq: unsigned 64-bit big-endian offset of the first payload byte in the session's stream
rest          raw PTY bytes
```

`seq` lets a client detect a gap. On a gap the client subscribes again and replaces its screen with
the new snapshot. The relay forwards the frame untouched to the clients subscribed to that session.

## Relay events

| Event | Data | When |
|---|---|---|
| `agent.status` | `{ online, name?, version?, hostname? }` | Sent to a client when it connects, and to all clients when the agent connects or drops. |

`name`, `version` and `hostname` come from the agent: as soon as it connects the relay sends it
`app.info`, and announces `online: true` with those fields when the answer arrives. If there is no
answer within 5 seconds the relay announces `online: true` without them. When a new agent connection
replaces an old one, clients see `online: false` followed by `online: true`.

## Methods

Ids are strings chosen by the agent. A client never builds one.

### App and workspace (sprint 2)

| Method | Params | Result |
|---|---|---|
| `app.info` | | `{ name, version, hostname, protocol: 1 }`. `name` is the Mac's computer name as System Settings shows it ("Ege's MacBook Pro"), `hostname` its network name, `version` the app's version. |
| `workspace.list` | | `{ windows: Window[] }` |
| `tab.create` | `{ window_id?, folder_id?, directory? }` | `{ tab_id, session_id }`. Opens a tab with one terminal and makes it the active tab. With `folder_id` the tab joins that folder, in the folder's window, and the terminal opens in the folder's directory (`window_id` and `directory` are then ignored). Without `window_id` the active window is used; without `directory`, the app's default. |
| `tab.activate` | `{ tab_id }` | `{}`. Also brings that tab, and its window, forward on the Mac. |
| `tab.close` | `{ tab_id }` | `{}`. The client confirms first; the Mac does not ask again. |

```ts
type Window = { id: string; active: boolean; folders: Folder[]; tabs: Tab[] };
type Folder = { id: string; name: string; directory: string; color: string | null; icon: string | null };
type Tab = { id: string; title: string; active: boolean; folder_id: string | null; panes: Pane[] };
type Pane = {
  id: string;
  kind: "terminal" | "file" | "other";
  title: string;
  focused: boolean;
  session_id: string | null;   // terminals only
  cwd: string | null;          // terminals only
  agent: { name: string; status: "working" | "waiting" | "done" | "failed"; message: string | null } | null;
};
```

`tabs` is in display order. A folder with no tabs is still listed in `folders`. One window has
`active: true` (the frontmost one) and each window has one active tab.

- `Folder.color` is `#RRGGBB`, or null when the folder has no colour.
- `Folder.icon` is null for the default icon, `material:<key>` for one of the app's bundled Material
  folder icons (for example `material:folder-src`), or `text:<text>` for a short text icon, usually
  one emoji. A client shows the default icon for a key it does not know.
- `Folder.name` is the name to display: the folder's own name, or the last part of `directory` when
  it has none.

Event `workspace.changed` (`{}`) is sent, at most twice a second, whenever the result of
`workspace.list` would differ. The client calls `workspace.list` again.

### Terminal (sprint 3)

| Method | Kind | Params | Result |
|---|---|---|---|
| `term.subscribe` | req | `{ session_id }` | `{ cols, rows, seq, snapshot }` |
| `term.unsubscribe` | req | `{ session_id }` | `{}` |
| `term.input` | ntf | `{ session_id, data }` | |
| `term.resize` | req | `{ session_id, cols, rows }` | `{ cols, rows }` |
| `term.release_size` | req | `{ session_id }` | `{}` |
| `theme.get` | req | | `{ terminal: { background, foreground, cursor, selection, ansi: string[16] }, font_family, font_size }` |

- `snapshot` is base64 of bytes that, written to an empty terminal of `cols` x `rows`, reproduce the
  current screen and recent scrollback. Output frames with `seq` at or after the returned `seq` follow.
- `term.subscribe` is safe to repeat. The relay keeps the set of subscribed clients per session,
  delivers output frames only to them, and sends `term.unsubscribe` to the agent when the last one
  leaves or disconnects. A client counts as subscribed from the moment the agent answers its
  `term.subscribe` with success, so the agent must send that response before the first output frame
  it covers. Every `term.subscribe` is forwarded, because each client needs its own snapshot; a
  `term.unsubscribe` is forwarded only for the last subscriber, and the others get `{}` from the relay.
- To the agent a session is either streaming or not: it starts on `term.subscribe` and stops on
  `term.unsubscribe`, which may arrive with a `relay:` id. If the relay receives output for a session
  nobody is subscribed to, it sends `term.unsubscribe` for it. When the agent connection drops, the
  relay forgets every subscription; clients subscribe again once `agent.status` says `online: true`.
- `term.unsubscribe` also gives the size back to the Mac, as `term.release_size` does, so a phone that
  goes away does not leave the terminal at phone size.
- `data` in `term.input` is the text or escape sequence to write to the PTY, exactly as a terminal
  emulator would send it.
- `term.resize` is the "fit to phone" switch. `term.release_size` gives the size back to the Mac.
  Event `term.size` (`{ session_id, cols, rows }`) is sent to subscribers when the size changes.
- Event `term.closed` (`{ session_id }`) is sent when the session ends, and ends its subscriptions.
- The relay delivers an event whose name starts with `term.` and whose data has a `session_id` only
  to that session's subscribers. Every other event goes to all clients.

### Files (sprint 4)

| Method | Params | Result |
|---|---|---|
| `fs.roots` | | `{ roots: { path, name }[] }`: the folder directories and terminal working directories |
| `fs.list` | `{ path }` | `{ entries: { name, kind: "dir" \| "file" \| "symlink", size, mtime }[] }`, directories first |
| `fs.read` | `{ path }` | `{ kind: "text", content, mtime, size }`, or `{ kind: "binary" \| "too_large", size }` (text limit 2 MB) |
| `fs.write` | `{ path, content, expected_mtime }` | `{ mtime }`, or error `failed` when the file changed since it was read |

Paths are absolute.

### Source control (sprint 5)

| Method | Params | Result |
|---|---|---|
| `git.repos` | | `{ repos: Repo[] }`: every repository and worktree under the open folders |
| `git.status` | `{ repo }` | `{ files: { path, status, staged }[] }` |
| `git.diff` | `{ repo, path }` | `{ diff }` as unified diff text |
| `git.commit` | `{ repo, message }` | `{ commit }`. Commits all changes, as the desktop button does. |
| `git.push` / `git.pull` | `{ repo }` | `{ output }` |
| `git.discard` | `{ repo, path? }` | `{}`. Without `path`, discards every change in the repo. |

```ts
type Repo = {
  path: string; name: string; branch: string | null; is_worktree: boolean;
  ahead: number; behind: number; changed: number;
};
```

### Notifications (sprint 6)

Event `notify`: `{ kind: "agent_waiting" | "agent_done" | "command_done", title, body, session_id, tab_id }`.
The relay turns it into a web push for every stored push subscription.

## Versioning

`app.info.protocol` is 1. A method the agent does not know returns `not_supported`, so a newer client
can run against an older app and hide what is missing.
