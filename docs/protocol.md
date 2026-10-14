# Hako remote protocol (v1)

Three parties:

- **Agent**: the Hako desktop app on the Mac. It dials out to the relay and never listens on the network.
- **Relay**: the server in this repo. It authenticates both sides and passes messages between them.
- **Client**: the web app in a browser.

The relay does not interpret workspace, file or git data. It routes requests to the agent, routes
responses back to the client that asked, and fans events out to clients. It forwards any method name
without knowing it; the only methods it reads are `app.info` and `preview.list` (which it calls
itself, see [Relay events](#relay-events) and [Previews](#previews-round-4)) and `term.subscribe` /
`term.unsubscribe` (to route terminal output). It also serves the previews' own origins, which it
tunnels to the Mac over byte streams ([Previews](#previews-round-4)).

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
| `GET /api/push/key` | | `{ key }`: the relay's VAPID public key. See [Notifications](#notifications-sprint-6) for this route and the five below. |
| `GET /api/push/device` | | `Device`: what the relay holds for the device of this login session. |
| `POST /api/push/subscribe` | `{ endpoint, keys: { p256dh, auth }, muted?, kinds? }` | `Device`. Stores the browser's push subscription for this session. |
| `POST /api/push/settings` | `{ muted?, kinds? }` | `Device`. Changes what this device is sent. |
| `POST /api/push/unsubscribe` | | `{ ok: true }`. Forgets this session's subscription. |
| `POST /api/push/test` | | `{ ok: true }` once the push service has taken a test notification for this device. |
| `POST /api/previews/ticket` | `{ id, path? }` | `{ url }`: a one-time address that lets this browser into a preview. See [Previews](#previews-round-4). |

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

Text frames are JSON. Binary frames carry terminal output (type `0x01`, below) and, between the
relay and the agent only, the data of [byte streams](#byte-streams) (type `0x02`).

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

A client may ask the relay to wait longer, or less long, for one request by putting `timeout_ms`, a
number of milliseconds, beside `params`:

```jsonc
{ "t": "req", "id": "8", "method": "git.push", "params": { "repo": "…" }, "timeout_ms": 300000 }
```

The relay then waits that long for this request, kept within 1,000 and 600,000 (a fraction is
dropped); anything that is not a finite number means the default 20 seconds. The relay decides this
from the field alone, never from the method name, and does not pass the field on: the agent sees
the same request frame as ever. The client uses it for the few methods that may legitimately take
long, which are named where they are described.

The relay also sends the agent requests of its own. Their ids start with `relay:` and the agent
answers them like any other request.

Error codes: `agent_offline`, `timeout`, `bad_request`, `not_found`, `not_supported`, `failed`. The file
methods add a few of their own, listed under [Files](#files-sprint-4), which the transfer methods
use too ([Transfers](#transfers-sprint-7)), and so do the source control methods, listed under
[Source control](#source-control-sprint-5).

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
| `app.info` | | `{ name, version, hostname, protocol: 1 }`. `name` is the Mac's computer name as System Settings shows it ("Ege's MacBook Pro"), `hostname` its network name, `version` the app's version, which is the string `dev` on a local build. |
| `workspace.list` | | `{ windows: Window[] }` |
| `tab.create` | `{ window_id?, folder_id?, directory? }` | `{ tab_id, session_id }`. Opens a tab with one terminal and makes it the active tab. With `folder_id` the tab joins that folder, in the folder's window, and the terminal opens in the folder's directory (`window_id` and `directory` are then ignored). Without `window_id` the active window is used; without `directory`, the app's default. With no window open at all, a new window is opened and the new tab is its first. |
| `tab.activate` | `{ tab_id }` | `{}`. Also brings that tab, and its window, forward on the Mac. |
| `tab.close` | `{ tab_id }` | `{}`. The client confirms first; the Mac does not ask again. Fails with `failed` and a message for the owner when the tab holds unsaved edits or when closing it would quit the app; the client shows the message and does not retry. |
| `folder.create` | `{ directory, window_id? }` | `{ folder_id }`. Adds a folder pointing at `directory` to the given window, or to the frontmost one, or to a new window when none is open. If a folder for that directory already exists in that window, it is not duplicated: the result is that folder's id. |

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
`active: true` (the frontmost one) and each window has one active tab. `windows` is empty when the
app runs with no window open.

- `Pane.agent` is null until the session has reported a status. A terminal can run a coding agent
  and still have `agent: null` (older agent plugins report nothing), so null means "no status to
  show", never "no agent" and never an error.
- A tab group without a directory is not a folder: it is left out of `folders`, and its tabs have
  `folder_id: null`.

- `Folder.color` is `#RRGGBB`, or null when the folder has no colour.
- `Folder.icon` is null for the default icon, `material:<key>` for one of the app's bundled Material
  folder icons (for example `material:folder-src`), or `text:<text>` for a short text icon, usually
  one emoji. A client shows the default icon for a key it does not know.
- `Folder.name` is the name to display, as the desktop sidebar shows it. It need not be the last
  part of `directory`: the home folder is named "Home".

#### `folder.create`

- `directory` is an absolute, normalised path, under the same rules as the paths of
  [Files](#paths). It must exist and be a directory: otherwise the answer is `not_found` or
  `not_a_directory`, and `permission_denied` when it cannot be read. These are the codes of the
  file methods, listed under [Files](#errors).
- The desktop app emits `workspace.changed` afterwards.
- The folder's name, colour and icon are the app's defaults; the name falls back to the last part
  of `directory`. A folder is renamed with [`folder.rename`](#renaming-round-2); recolouring and
  removing folders stay on the Mac.
- An older desktop app answers `not_supported`. The client finds out before it offers the action,
  by sending `folder.create` with `directory: "?"`, which is not a path and so can add nothing: an
  app that has the method answers `bad_request`, as for any malformed path.

Event `workspace.changed` (`{}`) is sent, at most twice a second, whenever the result of
`workspace.list` would differ. The client calls `workspace.list` again.

#### Renaming (round 2)

| Method | Params | Result |
|---|---|---|
| `tab.rename` | `{ tab_id, title }` | `{}` |
| `folder.rename` | `{ folder_id, name }` | `{}` |

**`tab.rename`** sets a tab's own title, as renaming the tab on the Mac does.

- `title` is a string of 1 to 200 characters after trimming whitespace, or `null` to go back to the
  automatic title. A missing `title` is taken as `null`. An empty string after trimming is
  `bad_request`.
- An unknown tab is `not_found`.
- `workspace.changed` follows, and `workspace.list` reports the new title as the tab's `title`.
- A terminal pane's own title is not renamed separately; on the phone a terminal is named by its
  tab.

**`folder.rename`** sets a tab folder's display name; the directory on disk is NOT renamed.

- `name` is 1 to 100 characters after trimming, or `null` to go back to the default name (the
  directory's last part, or the app's default such as "Home"). A missing `name` is taken as
  `null`.
- Folder ids, like tab ids, change when the app restarts; a client never keeps one across
  sessions.
- An unknown folder is `not_found`.
- `workspace.changed` follows.

Both answer `not_supported` on older apps. The client probes once per Mac connection by sending
`tab.rename` with `tab_id: "?"` (and `title: "?"`), which names no tab: an app that has round 2
answers `bad_request`. The client takes any answer other than `not_supported` (and other than the
Mac not answering at all) to mean that both methods are there.

### Terminal (sprint 3)

| Method | Kind | Params | Result |
|---|---|---|---|
| `term.subscribe` | req | `{ session_id }` | `{ cols, rows, seq, snapshot }` |
| `term.unsubscribe` | req | `{ session_id }` | `{}` |
| `term.input` | ntf | `{ session_id, data }` | |
| `term.resize` | req | `{ session_id, cols, rows }` | `{ cols, rows }` |
| `term.release_size` | req | `{ session_id }` | `{}` |
| `theme.get` | req | | `{ terminal: { background, foreground, cursor, selection, ansi: string[16] }, font_family, font_size }` |

`term.subscribe`, `term.resize` and `term.release_size` fail with `not_found` for a `session_id` the
Mac does not know. `term.unsubscribe` answers `{}` whether or not the session still exists.

#### Subscribing and the stream

- The session's output is one stream of bytes. `seq` numbers its bytes: every output frame carries
  the offset of its first byte, frames are sent in order, and each starts where the one before ended
  (`seq` of a frame = `seq` + payload length of the previous one). The counter never goes back while
  the session lives, and it stays below 2^53, because the client holds it in a JavaScript number.
  The desktop app starts every session at 0 and keeps counting across unsubscribes and across its
  own reconnects to the relay: a new subscription does not reset it. A client must not rely on 0,
  only on the `seq` of its snapshot.
- The stream is what the Mac's terminal was fed, which is the PTY's output with two differences in
  the desktop app: in its default prompt mode it puts `CR LF` after each shell prompt, so that the
  prompt sits on a line of its own, and it withholds the setup script it sends to a new shell. The
  bytes are still a valid terminal stream; they are just not a recording of the PTY.
- A frame may be empty. When bytes were left out of the stream and no output follows that would
  reveal it, the agent sends an output frame with a payload of length 0 that carries the new `seq`.
  A client treats it as any other frame: beyond the offset it expects, it is a gap. The desktop app
  does this after a `term.subscribe` that arrives while a new shell is still running its setup: the
  snapshot is empty, and a gap follows it.
- The desktop app flushes output every 12 ms while a terminal is busy, in frames of at most 64 KiB;
  a keystroke comes back as its echo in about 10 ms on the Mac's side.
- `term.subscribe` answers with the size the terminal has now (`cols`, `rows`), a `snapshot`, and
  the `seq` of the first byte the snapshot does not cover. Output frames with that `seq` and later
  follow. The agent sends the response before the first of those frames; the desktop app keeps
  responses and output in one ordered queue.
- `term.subscribe` is safe to repeat. The relay keeps the set of subscribed clients per session,
  delivers output frames only to them, and sends `term.unsubscribe` to the agent when the last one
  leaves or disconnects. A client counts as subscribed from the moment the agent answers its
  `term.subscribe` with success. Every `term.subscribe` is forwarded, because each client needs its
  own snapshot; a `term.unsubscribe` is forwarded only for the last subscriber, and the others get
  `{}` from the relay.
- To the agent a session is either streaming or not: it starts on `term.subscribe` and stops on
  `term.unsubscribe`, which may arrive with a `relay:` id. If the relay receives output for a session
  nobody is subscribed to, it sends `term.unsubscribe` for it. When the agent connection drops, the
  relay forgets every subscription; clients subscribe again once `agent.status` says `online: true`.
- The client subscribes when a terminal is opened, again whenever a frame does not start at the
  offset it expects (a gap), again when the page comes back to the foreground, and again after a
  reconnect. Each time it throws its screen away and draws the new snapshot. It sends
  `term.unsubscribe` when the terminal is left.
- Event `term.closed` (`{ session_id }`) is sent when the session ends, and ends its subscriptions.
  The client shows the terminal as ended and does not subscribe to that id again.
- The relay delivers an event whose name starts with `term.` and whose data has a `session_id` only
  to that session's subscribers. Every other event goes to all clients.

#### The snapshot

`snapshot` is base64 of bytes. The client resets its own terminal emulator (it writes `CAN` and
`ESC c` itself), sizes it to `cols` x `rows`, and writes the snapshot bytes, then the output frames.
What the snapshot must achieve:

- **The screen**: afterwards the emulator shows what the Mac's terminal shows: the visible rows with
  their colours and attributes, and the cursor in its place.
- **History**: recent scrollback comes first, oldest line first, so that it scrolls off the top as
  the screen is drawn. The client keeps 5,000 lines; a few thousand are plenty. Lines end with
  `CR LF`. A line that the Mac's terminal wrapped is written without a line break, so that it wraps
  again by itself.
- **Modes**: every mode that is set on the Mac's terminal and differs from a freshly reset one is
  set by the snapshot. The client encodes input from its own emulator's state, so two of them decide
  what it sends: application cursor keys (`CSI ? 1 h`, which turns arrow keys into `ESC O A`) and
  bracketed paste (`CSI ? 2004 h`). The others decide how later output is drawn: the alternate
  screen (`CSI ? 1049 h`, entered before its contents are drawn, with the normal screen's contents
  and history written first), cursor visibility, the scroll region, origin and auto-wrap mode, the
  character sets, and the colours and attributes in effect at the cursor.
- **A clean boundary**: the bytes from `seq` on must parse correctly after the snapshot. If the
  Mac's terminal is in the middle of an escape sequence or of a multi-byte character at `seq`, the
  snapshot ends with the bytes of that unfinished piece.
- A replay of raw recent output satisfies all of this only if it starts at a point where the
  terminal was in its reset state. The mock agent replays what it has, which is good enough to
  develop against; the desktop app is expected to serialise its emulator's state instead.
- With base64 the snapshot must stay well under the 8 MB frame limit.
- The desktop app's snapshot carries at most 2,000 rows of history. For a running program that is
  not full-screen it starts at the top of the screen, with the history above it in scrollback. It
  does not restore a saved cursor position, tab stops or the window title.

The client never answers what a program asks the terminal (device attributes, cursor position
reports, colour queries, focus events): the Mac's terminal answers those, and a second answer would
arrive as stray input. Neither the snapshot nor the stream needs to hide such requests.

#### Input

- `data` in `term.input` is text to write to the PTY, as UTF-8, exactly as a terminal emulator would
  send it: typed characters, control codes, escape sequences for keys, and mouse reports. The agent
  does not interpret it. Enter is `CR`.
- Mouse reports come from the client's own emulator state. While the program has turned mouse
  tracking on (`CSI ? 9 h`, `1000`, `1002` or `1003`), a tap on a phone is sent as a left button
  press and release at the tapped cell, in the encoding the program asked for: SGR
  (`CSI < 0 ; x ; y M` then `… m`) after `CSI ? 1006 h`, else the legacy `CSI M` form (press only
  for mode 9). Scrolling is sent as wheel reports in the SGR form only. So the snapshot must
  restore the mouse tracking mode and mode 1006 along with the other modes. Pasted text has its line breaks turned into `CR` and, when the
  program asked for bracketed paste, is wrapped in `ESC [ 200 ~` and `ESC [ 201 ~`.
- Input for a session that is not known, or has ended, is dropped.

#### Size

- A terminal has one size, shared by the Mac's window and every client. A client that does not ask
  for anything draws the terminal at the size it has and scales it to fit.
- `term.resize` is the "fit to phone" switch: it resizes the terminal (and its PTY) to `cols` x
  `rows`, both whole numbers of at least 2, and answers with the size the terminal really has
  afterwards, which the client then uses. The last request wins.
- Fitting only ever makes the terminal smaller. The client never asks for more columns or more
  rows than the terminal has on the Mac by itself: it remembers the last size the Mac reported
  while it had asked for none (the `cols` and `rows` of `term.subscribe`, and every `term.size`
  that arrives before its `term.resize` or after its `term.release_size`), and sends
  `min(wanted, that)` for each of the two numbers. A browser window larger than the Mac's pane
  therefore asks for the pane's own size. A pane resized beyond what its window shows loses its
  last rows on the Mac, which is where a full-screen program draws.
- `term.release_size` gives the size back to the Mac, which returns the terminal to the size its
  window gives it. `term.unsubscribe` does the same, and so does losing the relay connection, so a
  phone that goes away does not leave the terminal at phone size. With several clients the size is
  given back when the last subscriber leaves.
- `term.resize` for a session nobody is subscribed to changes nothing and answers with the size the
  terminal has.
- Event `term.size` (`{ session_id, cols, rows }`) is sent to the session's subscribers whenever the
  size changes for any reason, including to the client that asked for the change and when the Mac's
  own window is resized. It is sent in order with the output: bytes sent before it were laid out
  for the old size, bytes after it for the new one.
- The desktop app also resizes a terminal by itself when a program enters or leaves the alternate
  screen (from 155 x 47 to 159 x 45, say), so a `term.size` arrives around every `vim` or `less`.
  It is ordinary: the client applies it, and neither reports it nor asks for its own size again
  because of it.
- The client sends `term.resize` after subscribing while "fit to phone" is on, again when its own
  screen changes (rotation, the on-screen keyboard), and after a reconnect. It sends
  `term.release_size` when the switch is turned off and before the `term.unsubscribe` of leaving.

#### Theme

- The colours are `#RRGGBB` (`#RRGGBBAA` is accepted). `ansi` is the 16 colours in the usual order:
  black, red, green, yellow, blue, magenta, cyan, white, then the bright eight in the same order.
- `font_family` is one family name and `font_size` is in points as the Mac's settings show it. The
  client uses the family when the device has it, and its own monospace font otherwise.
- The client asks once each time the Mac comes online. With `not_supported` it uses a neutral dark
  scheme.

### Files (sprint 4)

| Method | Params | Result |
|---|---|---|
| `fs.roots` | | `{ home, roots: Root[] }` |
| `fs.list` | `{ path }` | `{ entries: Entry[], truncated }` |
| `fs.read` | `{ path }` | `ReadResult` |
| `fs.write` | `{ path, content, expected_mtime }` | `{ mtime, size }` |
| `fs.mkdir` | `{ path }` | `{}` |
| `fs.stat` | `{ path }` | `{ kind, size, mtime, target }` |
| `fs.create_file` | `{ path }` | `{ mtime }` |
| `fs.rename` | `{ path, name }` | `{ path }` |
| `fs.copy` | `{ sources, destination, on_conflict }` | `{ results: ItemResult[] }` |
| `fs.move` | `{ sources, destination, on_conflict }` | `{ results: ItemResult[] }` |
| `fs.trash` | `{ paths }` | `{ results: ItemResult[] }` |
| `fs.archive` | `{ path, skip_heavy }` | `{ path, name, size, skipped }` |
| `fs.extract` | `{ path, destination }` | `{ path, entries }` |

The last eight are described under [File operations (round 1)](#file-operations-round-1).

```ts
type Root = { path: string; name: string; source: "folder" | "terminal" | "home" };
type Entry = {
  name: string;
  kind: "dir" | "file" | "symlink" | "other";
  target: "dir" | "file" | "other" | null;   // symlinks only, otherwise null
  size: number;
  mtime: number;
};
type ReadResult =
  | { kind: "text"; content: string; mtime: number; size: number }
  | { kind: "image"; mime: string; data: string; mtime: number; size: number }
  | { kind: "binary"; size: number }
  | { kind: "too_large"; size: number; limit: number };
type ItemResult = {
  source: string;
  path: string | null;
  error: { code: string; message: string } | null;
};
```

These methods read and change files on the Mac as the user Hako runs as. They are not confined to
the roots: any path that user can reach is served, since the same client already has a shell. The
first four read directories and files and rewrite existing files, and `fs.mkdir` creates one
directory. Those of [round 1](#file-operations-round-1) create empty files, rename, copy, move, put
things in the Trash, zip a directory and unpack a zip; none of them deletes anything permanently.
No event is sent when a file changes on the Mac: the client asks again. Whole files of any kind, in
either direction, and new files with contents, are what [Transfers](#transfers-sprint-7) are for.

#### Paths

- A path is a string holding an absolute POSIX path. It starts with `/`, its segments are separated
  by single `/`, none of them is empty, `.` or `..`, and it does not end with `/`. The one exception
  is the root directory, which is `/` itself. Every other form, including `~`, `~/x`, `a/b`, `/a//b`,
  `/a/` and `/a/../b`, fails with `bad_request`, and so does a `path` that is missing or not a
  string. The agent expands nothing: no `~`, no environment variables.
- The client builds a path only by joining a path the agent gave it (a root's `path`, or a `cwd` or
  `directory` from the workspace) with entry names: `parent + "/" + name`, or `"/" + name` under the
  root directory. Names are passed back byte for byte; neither side changes their Unicode
  normalisation or their case.
- Symbolic links are followed, as the operating system follows them: `fs.list` of a link to a
  directory lists that directory, and `fs.read` and `fs.write` of a link act on the file it points
  to (the link itself stays a link). Paths are not made canonical, so a path that runs through a
  link is as good as any other. A link that points nowhere fails with `not_found`.
- A file or directory whose name is not valid UTF-8 cannot be named in JSON and is left out of
  listings.

#### Sizes and times

- `size` is the length in bytes. For a directory it is `0`.
- `mtime` is the time of the last modification in whole milliseconds since the Unix epoch (UTC), an
  integer. The agent takes the file system's time and drops everything below a millisecond (it
  rounds down), the same way in `fs.list`, `fs.read` and `fs.write`, so that two values for the same
  unchanged file are always equal.
- For a symlink, `size` and `mtime` describe what it points to. A link that points nowhere has
  `target: null`, `size: 0`, and the `mtime` of the link itself.

#### `fs.roots`

`home` is the user's home directory, always present; the client uses it to show paths as `~/…`.
`roots` are the places browsing starts from, in this order:

1. Each folder's `directory`, in the order of `workspace.list` (window by window, then folder by
   folder), with `name` equal to the folder's `name` and `source: "folder"`.
2. The home directory, with `name: "Home"` and `source: "home"`.
3. The `cwd` of each terminal pane, in the order of `workspace.list` (window, tab, pane), with
   `name` equal to the last segment of the path (`/` for the root directory) and
   `source: "terminal"`.

A path appears once: an item whose `path` equals an earlier one is dropped. So a home directory that
is also an open folder is listed as that folder and not again as `"home"`, and a terminal sitting in
a folder's directory or in the home directory adds nothing. Paths are compared as strings. A
directory nested inside another root is still listed. Directories that no longer exist are listed
all the same; `fs.list` then says `not_found`. Roots change only when `workspace.list` would, so the
client reads them again after `workspace.changed`.

#### `fs.list`

- Lists one directory, without recursion, and with every entry, hidden ones (names starting with
  `.`) included. `.` and `..` are never entries. The client decides what to hide.
- `kind` is `dir` for a directory, `file` for a regular file, `symlink` for a symbolic link and
  `other` for anything else (a socket, a FIFO, a device). For a symlink, `target` says what it
  points to after following every link, or is `null` when it points nowhere or cannot be followed;
  for the other kinds `target` is `null`. An entry the agent cannot examine is listed as `other`
  with `size: 0` and `mtime: 0`.
- Order: entries that are directories (`kind: "dir"`, or a symlink with `target: "dir"`) come first,
  then all others. Inside each group entries are ordered by their name in lower case, compared code
  point by code point, and two names that are equal in lower case by the names themselves, compared
  the same way. The client may order them differently for display.
- At most 20,000 entries are returned. `truncated` is `true` when the directory holds more, and the
  entries are then the first 20,000 in the order above; otherwise it is `false`.
- Errors: `not_found` when nothing is at `path`, `not_a_directory` when it is not a directory,
  `permission_denied` when the Mac refuses to read it.

#### `fs.read`

The agent decides in this order what the file is:

1. **Image.** The name ends, in any letter case, with one of these extensions:

   | Extension | `mime` |
   |---|---|
   | `.png` | `image/png` |
   | `.jpg`, `.jpeg` | `image/jpeg` |
   | `.gif` | `image/gif` |
   | `.webp` | `image/webp` |
   | `.svg` | `image/svg+xml` |

   The result is `{ kind: "image", mime, data, mtime, size }`, where `data` is the file's bytes in
   base64 (the standard alphabet, with `=` padding, without line breaks). The limit is 5 MiB
   (5,242,880 bytes): a larger image gives `{ kind: "too_large", size, limit: 5242880 }`. The agent
   does not look inside the file; the extension alone decides, so an SVG file is always an image
   here and never text. The client draws the image in an `<img>` element and never puts its
   contents into the page as markup, so nothing inside an SVG runs.
2. **Too large.** Any other file longer than 2 MiB (2,097,152 bytes) gives
   `{ kind: "too_large", size, limit: 2097152 }`, without being read.
3. **Binary.** A file that contains a NUL byte, or whose bytes are not valid UTF-8, gives
   `{ kind: "binary", size }`. The agent never decodes with replacement characters, so a file the
   client can show is a file it can write back unchanged.
4. **Text.** Everything else gives `{ kind: "text", content, mtime, size }`. `content` is the whole
   file decoded as UTF-8 and nothing else: line endings are left as they are (`LF`, `CR LF`, mixed),
   and a byte order mark at the start stays in `content` as U+FEFF. An empty file is text with
   `content: ""`.

`size` is always the file's length in bytes, and `mtime` belongs to the bytes that were returned.
A text result that would not fit in a frame once encoded (a file full of control characters grows
in JSON) is answered as `too_large` with `limit: 2097152`.

Errors: `not_found`, `is_a_directory` when `path` is a directory, `permission_denied`, and `failed`
for anything that is neither a directory nor a regular file.

#### `fs.write`

- Replaces the whole contents of an existing regular file with `content`, a string, encoded as
  UTF-8 exactly as given: the agent adds, removes and converts nothing (no final newline, no line
  ending conversion, no byte order mark). The file keeps its permission bits.
- **It never creates a file.** When nothing is at `path` the answer is `not_found`; a directory gives
  `is_a_directory`.
- `expected_mtime` is the `mtime` the client got from `fs.read` (or from its last `fs.write`), or
  `null`. With a number, the agent compares it with the file's `mtime` now, computed as above. If
  they differ in either direction the file has changed since the client read it: nothing is written
  and the answer is the error `conflict`. With `null` the check is skipped, which is how the client
  overwrites after the owner chose to. `expected_mtime` must be present; leaving it out is
  `bad_request`.
- `content` may be at most 2 MiB (2,097,152 bytes) once encoded; more fails with `too_large`.
- The result is the file's new `mtime` and `size`, which the client uses as `expected_mtime` for its
  next write.
- A write that fails leaves the file as it was, whole: the agent writes a temporary file in the
  same directory and renames it over the original, or does something of equal effect. Through a
  symlink it replaces the file the link points to, not the link.
- Errors: `bad_request`, `not_found`, `is_a_directory`, `permission_denied` (a read-only file, a
  directory the user may not write to), `conflict`, `too_large`, and `failed` for any other trouble,
  such as a full disk.

#### `fs.mkdir`

- Creates exactly one directory, at `path`. There is no recursive creation: the parent of `path`
  must exist and be a directory, otherwise the answer is `not_found` or `not_a_directory`.
- An existing entry at `path`, of any kind, gives `conflict`.
- The last component of `path` must be 1 to 255 bytes long, must not be `.` or `..`, and must not
  contain `/` or NUL. Anything else is `bad_request`.
- `permission_denied` as usual.
- The result is `{}`.
- An older desktop app answers `not_supported`.

#### Errors

The file methods add these codes to the ones under [Frames](#frames):

| Code | Meaning |
|---|---|
| `not_found` | Nothing exists at `path`, or a link on the way points nowhere. |
| `not_a_directory` | `fs.list` of something that is not a directory; `fs.mkdir` or `fs.create_file` under a parent that is not one; a `destination` that is not one. |
| `is_a_directory` | `fs.read` or `fs.write` of a directory. |
| `permission_denied` | The Mac refused: the operating system's `EACCES` or `EPERM`, or a macOS privacy rule. |
| `conflict` | `fs.write`: the file's `mtime` is not `expected_mtime`. `fs.mkdir`, `fs.create_file`: something already exists at `path`. `fs.rename`: the name is taken. `fs.copy`, `fs.move`: an item's name is taken (see `on_conflict`). |
| `too_large` | `fs.write`: `content` is over the limit. `fs.archive`, `fs.extract`: over a limit, with `limit` (see [round 1](#too_large-with-limit)). (`fs.read` reports a large file as a result, not as an error.) |
| `bad_request` | A malformed path or a missing or mistyped parameter. |
| `failed` | Anything else. |

`message` is a sentence for the owner, which the client shows as it is for `permission_denied` and
`failed`: say what the Mac said, for example "Permission denied: /Users/ege/Library/Mail". A client
that does not know a code treats it as `failed`. An agent without these methods answers
`not_supported`, as for any unknown method, and the client tells the owner to update Hako on the
Mac.

### File operations (round 1)

Path rules, `mtime` units, the name rule, error codes and the `timeout_ms` mechanism are those
above unless stated here.

The **name rule** (as for `fs.mkdir`): a single path component of 1 to 255 bytes, not `.` or `..`,
no `/`, no NUL; otherwise `bad_request`.

All the methods of this section answer `not_supported` on an older desktop app. The client probes
once per Mac connection (like `folder.create` with `directory: "?"`) by sending `fs.stat` with
`path: "?"`; an app that has round 1 answers `bad_request`.

#### `fs.stat`

`{ path }` -> `{ kind, size, mtime, target }`

`kind` as in `fs.list` (`dir`, `file`, `symlink`, `other`), `size` bytes, `mtime` ms, `target` the
symlink target or null. Symlinks are reported, not followed (so `kind` can be `symlink`);
`not_found`, `permission_denied`.

`target` here is what the link holds, as a string (`../docs`), unlike the `target` of an `fs.list`
entry, which says what a link points to (`"dir"`, `"file"`, `"other"`). For a symlink, `size` and
`mtime` are the link's own.

#### `fs.create_file`

`{ path }` -> `{ mtime }`

Creates an empty regular file (mode from the umask). The parent must exist and be a directory
(`not_found`, `not_a_directory`); an existing entry gives `conflict`; the last component follows
the name rule.

#### `fs.rename`

`{ path, name }` -> `{ path }`

Renames a file, directory or symlink within its own directory; `name` follows the name rule; result
is the new absolute path. An existing entry with that name gives `conflict`, except a change of
letter case only of the same entry, which is allowed. Renaming `/` or the home directory is
`bad_request`.

#### `fs.copy` and `fs.move`

`{ sources, destination, on_conflict }` -> `{ results }`

- `sources`: 1 to 500 absolute paths (files, directories, symlinks). `destination`: an existing
  directory (`not_found`, `not_a_directory`, `permission_denied` for the whole request).
  `on_conflict`: `"fail"` (default), `"rename"` (keep both: `name (2).ext`, `name (3).ext` …; for
  directories `name (2)`), or `"replace"` (only replaces a regular file or symlink with a regular
  file or symlink; replacing a directory, or a file with a directory, is a `conflict` for that
  item).
- `results`: one entry per source, in order: `{ source, path, error }`. `path` is the new absolute
  path or null; `error` is null or `{ code, message }` with the usual codes. Items are
  independent: one failing item never undoes others.
- A malformed path among `sources` (or among the `paths` of `fs.trash`) fails only that item, with
  `bad_request`; the request as a whole is `bad_request` only when the list itself is missing,
  empty or longer than 500.
- A move between volumes that copied an item but could not remove the original answers with BOTH
  `path` (the copy) and `error` (why the original is still there) for that item. The client says
  "copied, but the original could not be removed: <message>".
- Copying an item into its own directory with `"fail"` gives `conflict` for that item; with
  `"rename"` it makes a copy with a `(2)` name (this is how the client offers Duplicate).
- Copying or moving a directory into itself or one of its descendants is `bad_request` for that
  item. Moving an item onto itself (same path) is a no-op with `path` equal to `source`.
- Copy is recursive, keeps permissions and modification times, and copies symlinks as symlinks
  (never follows them). Move is a rename when possible and otherwise copy then delete on success
  of the copy.
- The client sends `timeout_ms: 300000`. The desktop stops working on a request after 240 seconds;
  items not finished by then get `{ code: "failed", message: "Stopped after 240 seconds" }` and
  anything half-copied for that item is removed.

Where the contract left room:

- The numbered names of `"rename"` are those of [When the name is taken](#when-the-name-is-taken)
  for a file (`notes (2).txt`, `archive.tar (2).gz`, `.env (2)`). A directory is numbered at the
  end of its whole name, dots and all: `v1.2` becomes `v1.2 (2)`.
- Copying an item into its own directory with `"replace"` would replace the item with itself; it is
  a `conflict` for that item and nothing changes. The client never asks for it: it copies into the
  same directory only with `"rename"`.
- The paths that may not go to the Trash (`/`, the home directory, a tab folder's own directory)
  are refused item by item, like any other failing item.

#### `fs.trash`

`{ paths }` -> `{ results }`

- `paths`: 1 to 500 absolute paths. Each is moved to the macOS Trash (so "Put Back" works on the
  Mac); `results` as for copy: `{ source, path, error }` with `path` the item's location in the
  Trash when known, else null. Never deletes permanently. Moving `/`, the home directory or a tab
  folder's own directory to the Trash is `bad_request`.

#### `fs.archive`

`{ path, skip_heavy }` -> `{ path, name, size, skipped }`

- Zips a directory (a file is `bad_request`; use `fs.download` for files) into a fresh file under
  the desktop's archives area (`~/.hako/archives/<random>/<directory name>.zip` on the owner's Mac;
  the profile-aware data directory), and returns its absolute path, file name, size in bytes and
  `skipped`, the number of directories left out.
- `skip_heavy` (default true) leaves out every directory named `.git`, `node_modules`, `.venv`,
  `venv`, `__pycache__`, `.next`, `.turbo`, `.gradle`, `Pods`, `DerivedData`, and every directory
  named `target` that contains a `CACHEDIR.TAG` file or a `.rustc_info.json`. With
  `skip_heavy: false` everything is included.
- Symlinks are stored as symlinks. Unreadable entries are skipped silently and do not fail the
  archive. The zip uses standard deflate and UTF-8 names and opens in macOS, iOS Files and Windows.
- If the archive would exceed the transfer limit (`max_bytes`), work stops and the answer is
  `too_large` with `limit`. The client sends `timeout_ms: 300000`; the desktop stops after 240
  seconds with `failed`.
- The client then downloads the returned path with the existing `fs.download`. Archives are
  deleted one hour after they were made, and at the desktop app's start.

#### `fs.extract`

`{ path, destination }` -> `{ path, entries }`

- Extracts a `.zip` file into a NEW directory inside `destination` named after the zip without its
  extension (`photos.zip` -> `photos`, keep-both naming `photos (2)` when taken), and returns that
  directory's path and the number of entries written.
- Refuses (`bad_request`) archives with an entry that would land outside the new directory
  (absolute paths, `..`, symlinks pointing outside), encrypted archives, and archives whose total
  uncompressed size exceeds 1 GiB or that contain more than 50,000 entries (`too_large` with
  `limit`). A corrupt archive is `failed` with the reason. On any failure the new directory is
  removed. `__MACOSX` folders and `.DS_Store` files are skipped.
- `timeout_ms: 300000` from the client, 240 seconds on the desktop as above.
- If every entry in the zip lies under one top-level directory (ignoring skipped `__MACOSX` and
  `.DS_Store` entries), the CONTENTS of that directory go directly into the new directory, and the
  new directory is named after that top-level directory rather than after the zip (keep-both naming
  as before). Otherwise behaviour is unchanged. So a zip made by `fs.archive` of folder `photos`
  extracts to `photos` (or `photos (2)`), never `photos/photos`. (Decided after round 1 was first
  written; an app that predates it extracts such a zip to `photos/photos`.)

#### `too_large` with `limit`

An error frame's `error` is `{ code, message }` everywhere else. "`too_large` with `limit`" adds
one field to it: `{ code: "too_large", message, limit }`, where `limit` is the number that was
exceeded. For `fs.archive` it is `max_bytes`, in bytes. For `fs.extract` it is either 1,073,741,824
(bytes, for the uncompressed size) or 50,000 (entries); `message` says which. A client that finds no
`limit` says only that the archive is too large.

### Transfers (sprint 7)

| Method | Params | Result |
|---|---|---|
| `fs.transfer_info` | | `{ max_bytes, chunk_bytes }` |
| `fs.download` | `{ path, offset, length, expected_size, expected_mtime }` | `{ data, size, mtime }` |
| `fs.upload_begin` | `{ destination, name, size, on_conflict }` | `{ upload_id }` |
| `fs.upload_chunk` | `{ upload_id, offset, data }` | `{ received }` |
| `fs.upload_end` | `{ upload_id }` | `{ path, name, size, mtime }` |
| `fs.upload_cancel` | `{ upload_id }` | `{}` |

```ts
type Destination =
  | { kind: "dir"; path: string }   // a directory on the Mac
  | { kind: "uploads" };            // the app's own uploads area
type OnConflict = "fail" | "replace" | "rename";
```

These move whole files between the client's device and the Mac: a download of any regular file,
an upload of a new file into a directory, and an upload into the app's own uploads area, which is
how a picture taken on the phone reaches a program in a terminal. A file travels in pieces through
ordinary request and response frames, each piece as base64 in a JSON string. There is no other
channel and the relay knows nothing of it: it forwards these six methods like any other.

Paths, sizes and `mtime` are as under [Files](#files-sprint-4), and so is whom these methods act
as: the user Hako runs as, with no confinement to the roots.

#### Limits

| | Value |
|---|---|
| Largest file, either direction (`max_bytes`) | 200 MiB: 209,715,200 bytes (50 MiB before round 1) |
| Most bytes in one piece, before base64 (`chunk_bytes`) | 1 MiB: 1,048,576 bytes |
| Largest frame a piece makes | about 1.4 MB, against the relay's 8 MB |
| An unfinished upload is kept | 15 minutes after the last request that named it |
| The result of a finished upload is kept | 10 minutes |
| A file stays in the uploads area | 7 days |

`fs.transfer_info` answers with the first two as the agent has them. In this version they are the
numbers above (clients must keep reading the limit from `fs.transfer_info`, since an app from before
round 1 still answers 50 MiB), and an agent must not report a `chunk_bytes` over 4,194,304. The client takes both
from this answer: it refuses a larger file before sending or asking for anything, asks for pieces
of exactly `chunk_bytes` (the last one shorter), and sends pieces of exactly that size.

`fs.transfer_info` is also how the client learns that the agent has these methods at all. It asks
once each time the Mac comes online. `not_supported` means an older app: the client then offers
neither downloads, uploads nor attaching pictures, and says to update Hako on the Mac, instead of
starting a transfer that fails half-way.

`data` is base64 in the standard alphabet with `=` padding and without line breaks, as in
`fs.read`. Anything else in an `fs.upload_chunk` is `bad_request`.

The client sends `fs.download`, `fs.upload_chunk` and `fs.upload_end` with `timeout_ms: 60000`
(see [Frames](#frames)), since a piece can take a while on a slow link and placing a file can take
a moment on a slow disk. The other three use the relay's 20 seconds.

#### `fs.download`

Reads one piece of a file. The agent keeps nothing between two calls: every call names the file
and says which bytes it wants.

- `path` names a regular file, through symbolic links as the operating system follows them.
- `offset` and `length` are whole numbers of bytes: `offset` from 0 up to the file's size,
  `length` from 1 up to `chunk_bytes`. The answer's `data` holds the bytes from `offset` up to
  `offset + length`, or up to the end of the file when that comes first. So an `offset` equal to
  the size, which is also the first and only piece of an empty file, gives `data: ""`. An `offset`
  beyond the size, a `length` out of range, or a number that is not a whole number, is
  `bad_request`.
- `size` and `mtime` describe the file as it was when the piece was read.
- `expected_size` and `expected_mtime` must both be present, and are both `null` or both numbers;
  anything else is `bad_request`. With `null` the agent answers for the file as it is. With
  numbers, it compares them with the file's size and `mtime` now, and when either differs it reads
  nothing and answers `conflict`: the file was written to since the client's first piece. The
  agent also answers `conflict` when the file changes while it is reading the piece, which it
  sees as a short read or as a size or `mtime` that differ after the read from before it.
- A file larger than `max_bytes` is `too_large`, at every piece, whatever was asked for.
- Other errors: `not_found`, `is_a_directory`, `permission_denied`, and `failed` for something
  that is neither a directory nor a regular file.

The client asks for the first piece with `offset: 0`, `length: chunk_bytes` and both expectations
`null`, takes `size` and `mtime` from the answer, and asks for each further piece with those two
as its expectations, one request at a time, in order, until it has `size` bytes. The agent need
not rely on the order: any piece may be asked for at any time, and twice. A `conflict` ends the
download; the client throws away what it has and offers to start again.

#### Uploading

An upload is three steps: `fs.upload_begin` announces a file and answers with an id, as many
`fs.upload_chunk` as it takes carry its bytes, and `fs.upload_end` puts the file in place.

**`fs.upload_begin`**

- `destination` says where the file goes: `{ kind: "dir", path }` for a directory on the Mac
  (`path` as under [Paths](#paths), followed through symbolic links), or `{ kind: "uploads" }`
  for [the uploads area](#the-uploads-area). A missing or malformed `destination` is `bad_request`.
- `name` is the file's name: one path segment, not empty, not `.` or `..`, without `/` and without
  a NUL character, at most 255 bytes in UTF-8. Anything else is `bad_request`. In a directory the
  file gets exactly this name, byte for byte. In the uploads area it gets a name made from it.
- `size` is the whole file's length in bytes, a whole number from 0 up to `max_bytes`. More is
  `too_large`; anything that is not such a number is `bad_request`.
- `on_conflict` says what happens when the directory already holds something called `name`:
  `"fail"` (also what a missing `on_conflict` means), `"replace"` or `"rename"`. It is described
  under [When the name is taken](#when-the-name-is-taken), and ignored for the uploads area.
- The agent creates an empty temporary file beside where the file will be:
  `.hako-upload-<upload_id>` in the destination directory, created so that it fails if that name
  exists, readable and writable by the user only. It is a sibling so that putting the file in
  place is a rename within one file system. Creating it is also the test of whether the directory
  can be written to: `permission_denied` is answered here, before a byte is sent.
- `upload_id` is a string chosen by the agent: 1 to 64 characters of ASCII letters, digits, `-`
  and `_`. It names the upload in the three other methods.
- Errors: `bad_request`, `too_large`, `not_found` when nothing is at `path`, `not_a_directory`,
  `permission_denied`, `conflict` and `is_a_directory` as described below, `failed` for anything
  else, such as a full disk.

**`fs.upload_chunk`**

- `data` holds the next 1 to `chunk_bytes` bytes of the file, and `offset` says where in the file
  they belong. The agent appends them to the temporary file and answers with `received`, the
  number of bytes of the file it now has.
- **Pieces come in order.** `offset` must be equal to the `received` of the answer before (0 for
  the first piece): the client sends one piece, waits for its answer, and sends the next.
- **A piece may be repeated.** When `offset + (length of the piece)` is not more than what the
  agent already has, the piece is one whose answer was lost on the way: the agent writes nothing
  and answers with the `received` it has. This is how an upload goes on after a broken
  connection: the client sends its last unanswered piece again, exactly as it was.
- Any other `offset` (a gap, or a piece that starts inside what has arrived and ends beyond it),
  a piece that would take the file past the `size` that was announced, and an empty or oversized
  piece are `bad_request`, and the upload stays as it was.
- An `upload_id` the agent does not have is `not_found`: it was cancelled, it expired, or the app
  was restarted. A write that fails (a full disk) is `failed`, and ends the upload: the agent
  removes the temporary file and forgets the id.

**`fs.upload_end`**

- When fewer than `size` bytes have arrived the answer is `bad_request` and the upload stays open.
- Otherwise the agent checks that the temporary file is exactly `size` bytes long, gives it its
  permissions, and renames it into place. **Only now does a file of the real name exist**, and it
  is whole: an upload that breaks off at any earlier point leaves nothing under that name, and a
  file that is replaced stays as it was until this moment.
- A new file gets the permissions any new file of that user gets (`0644` less the umask). A file
  that replaces another keeps the permission bits of the one it replaces. A file in the uploads
  area is readable and writable by the user only (`0600`).
- The result names the file as it now is: `path` (absolute), `name` (its last segment, which
  differs from the `name` that was sent after `"rename"` and in the uploads area), `size` and
  `mtime`. For a directory, `path` is the `path` of `destination` joined with `name`, not made
  canonical.
- **The answer can be asked for again.** The agent remembers the result of every finished upload
  for 10 minutes and answers a repeated `fs.upload_end` for that id with the same result, so a
  client whose connection broke while it waited learns what happened. After that the id is
  `not_found`.
- Whatever error `fs.upload_end` answers other than that first `bad_request` ends the upload: the
  temporary file is removed and the id forgotten.

**`fs.upload_cancel`** removes the temporary file and forgets the id. It answers `{}` whether or
not the id is known. It does not undo an upload that has ended.

**Unfinished uploads.** An upload belongs to the app, not to a connection: it survives the
client's connection and the agent's own reconnects to the relay. The agent gives up on one that no
request has named for 15 minutes, removing its temporary file and forgetting its id, and it
removes the temporary files of the uploads that were unfinished when the app quit, at quitting
where it can and at its next start otherwise (so it keeps a record of them somewhere that
outlives it). A client sends one upload at a time; an agent may hold several.

#### When the name is taken

For a directory, with `name` already there, whatever it is (a file, a directory, a link):

| `on_conflict` | At `fs.upload_begin` | At `fs.upload_end` |
|---|---|---|
| `"fail"` | `conflict`. Nothing is created. | If the name was taken in the meantime: `conflict`, and the upload is discarded. The file is placed by a means that cannot replace one (`link` and `unlink`, or `renamex_np` with `RENAME_EXCL`), never by a check followed by a rename. |
| `"replace"` | Accepted, unless what is there is a directory: `is_a_directory`. | The temporary file is renamed over what is there. A symbolic link of that name is itself replaced, not the file it points to. A directory there by now is `is_a_directory`. |
| `"rename"` | Accepted. | The file gets the first free name of `name`, `stem (2).ext`, `stem (3).ext`, …, placed by the same means as for `"fail"`, so two uploads cannot take one name. |

- `stem` and `.ext` are `name` cut at its last `.`; a name without a dot, or whose only dot is its
  first character (`.env`), has no extension and is numbered at its end: `Makefile (2)`,
  `.env (2)`. So `notes.txt` becomes `notes (2).txt` and `archive.tar.gz` becomes
  `archive.tar (2).gz`. When the numbered name would be longer than 255 bytes, the agent shortens
  the stem.
- The client always begins with `"fail"`. On `conflict` it asks the owner, in the page, whether to
  replace the file, keep both, or leave it, and begins again with `"replace"` or `"rename"`, or
  not at all. Nothing is replaced without that answer, and closing the question is "leave it".

#### The uploads area

`{ kind: "uploads" }` stores the file in a place of the app's own instead of in the owner's
folders. It is for files that are handed to a program by their path and are of no further use,
which today means one thing: a picture the owner picked or took on the phone while in a terminal.

- The area is `~/.hako/uploads` in the home directory of the user Hako runs as. A file goes into
  the directory of the day its upload began, by the Mac's own clock and time zone:
  `~/.hako/uploads/2026-10-13/`. The agent creates what is missing, for the user only (`0700`).
- The file's name is made from `name`, so that its path can be typed into a shell as it is:
  1. When `name` has a `.` that is not its first character, followed by 1 to 8 ASCII letters or
     digits and nothing else, those are the extension, in lower case. Otherwise there is none.
  2. In the rest, every character other than an ASCII letter, a digit, `.`, `_` and `-` becomes
     `-`; a run of `-` becomes one; `-` and `.` are trimmed from both ends; what is left is cut
     to its first 64 characters, and trimmed of `-` and `.` at its end again. If nothing is left
     it is `file`.
  3. The name is that, then the extension: `Screen Shot (1).PNG` becomes `Screen-Shot-1.png`,
     and `fotoğraf.heic` becomes `foto-raf.heic`.
  4. Nothing is ever replaced there, and `on_conflict` is not looked at. When the name is taken
     the file becomes `Screen-Shot-1-2.png`, then `-3`, and so on, placed as for `"fail"` above.
- The result's `path` is the file's absolute path, and from the area's directory down it holds
  nothing but ASCII letters, digits, `.`, `_`, `-` and `/`.
- The agent does not look at what the file is. Any file up to `max_bytes` is taken.
- **Clean-up.** A file in the area whose `mtime` is more than 7 days old is deleted, and a day's
  directory left empty is removed. The agent does this when it starts and at least once a day
  while it runs. Nothing else is ever deleted there, and nothing outside the area.

What the client does with it, in a terminal:

1. The owner picks one or more pictures, or takes one. Claude Code takes PNG, JPEG, GIF and WebP,
   so the client looks at each file's first bytes: one of those four, with no side longer than
   2,576 pixels, is sent as it is, byte for byte. Anything else (an iPhone's HEIC) is drawn again
   as a JPEG, and a picture with a longer side is scaled down to 2,576 pixels on that side first,
   with its orientation applied. The agent never converts anything.
2. Each is uploaded with `{ kind: "uploads" }`, one after another.
3. When `fs.upload_end` has answered, the client writes the `path` it got, followed by one space,
   as pasted text: with `term.input`, wrapped as a bracketed paste when the terminal has that
   mode on (see [Input](#input)), or into its message box when that is where the owner is
   writing. It adds a backslash before every character of the path that is not an ASCII letter,
   a digit or one of `._/+@%:,=~-`, as a terminal does when a file is dragged into it, and it
   never presses Enter. A program that turns a dropped picture's path into an attached picture,
   as Claude Code does, then has the picture.
4. If the upload fails, nothing is written to the terminal.

#### Errors

The transfer methods use the codes of the file methods, with these meanings:

| Code | Meaning |
|---|---|
| `bad_request` | A malformed path, name, destination or `upload_id`; a number that is missing, not whole or out of range; `data` that is not base64; a piece out of order or beyond `size`; `fs.upload_end` before every byte has arrived. |
| `not_found` | `fs.download`: nothing is at `path`. `fs.upload_begin`: the directory does not exist. The other upload methods: the agent has no upload of that id (any more). |
| `not_a_directory` | `fs.upload_begin`: `path` is not a directory. |
| `is_a_directory` | `fs.download` of a directory. An upload with `"replace"` whose name is a directory. |
| `permission_denied` | The Mac refused: the file may not be read, or the directory may not be written to. `message` says what the Mac said. |
| `conflict` | `fs.download`: the file's size or `mtime` is not what was expected. `fs.upload_begin` and `fs.upload_end` with `"fail"`: the name is taken. |
| `too_large` | The file is over `max_bytes`. |
| `failed` | Anything else: a full disk, a file that is not a regular file. `message` is a sentence for the owner. |

`message` is shown to the owner as it is for `permission_denied` and `failed`. An agent without
these methods answers `not_supported`, as for any unknown method.

#### When the link breaks

A request that was on its way when a connection dropped fails with `agent_offline` (the Mac's
side) or is simply never answered (the client's side). The client does not give the transfer up:
it waits until the relay says the Mac is online again and repeats the request it was waiting for.
For a download that is the same `fs.download`. For an upload it is the same `fs.upload_chunk`,
which the agent tells from a new piece by its `offset`, or the same `fs.upload_end`, which the
agent answers from memory. So an iPhone that put the app in the background for a minute carries
on where it was. When the agent no longer has the upload (`not_found`) the transfer has failed,
and the client offers to start it again from the first byte. A request that the relay timed out
is repeated twice before the transfer fails.

### Source control (sprint 5)

| Method | Params | Result |
|---|---|---|
| `git.repos` | | `{ repos: Repo[] }` |
| `git.status` | `{ repo }` | `{ repo: Repo, files: File[], truncated, merge? }` |
| `git.diff` | `{ repo, path, old_path?, commit? }` | `Diff` |
| `git.commit` | `{ repo, message }` | `{ commit, output, repo: Repo }` |
| `git.push` | `{ repo }` | `{ output, published, repo: Repo }` |
| `git.pull` | `{ repo }` | `{ output, repo: Repo }` |
| `git.discard` | `{ repo, path?, old_path? }` | `{ repo: Repo }` |
| `git.branches` | `{ repo }` | `{ current, detached, head, branches: Branch[], truncated }` |
| `git.switch` | `{ repo, branch, kind }` | `{ current, head }` |
| `git.log` | `{ repo, limit, skip }` | `{ commits: Commit[], has_more, head, upstream }` |
| `git.show` | `{ repo, commit }` | `{ commit: Commit, body, files: File[], truncated }` |
| `git.merge` | `{ repo, branch, kind }` | `{ outcome, head, conflicts, output }` |
| `git.merge_abort` | `{ repo }` | `{ head }` |

```ts
type Repo = {
  path: string;                 // the root of the working tree; this is the repository's identity
  name: string;                 // the last segment of `path`
  root: string;                 // the folder directory the repository belongs to
  is_worktree: boolean;         // true for a linked worktree
  main_path: string | null;     // linked worktrees only: the working tree of the repository it belongs to
  branch: string | null;        // the short name of the current branch; null when HEAD is detached
  head: string | null;          // the full id of the commit HEAD is at; null before the first commit
  upstream: string | null;      // the branch this one tracks, such as "origin/main"; null when it tracks none
  ahead: number;                // commits on the branch that the upstream does not have; 0 without an upstream
  behind: number;               // commits on the upstream that the branch does not have; 0 without an upstream
  changed: number;              // how many files `git.status` would list, before its limit
  operation: "merge" | "rebase" | "cherry-pick" | "revert" | null;
};
type File = {
  path: string;                 // relative to the repository's `path`
  old_path: string | null;      // renamed files only: where the file was
  status: "modified" | "added" | "deleted" | "renamed" | "untracked" | "conflicted";
  additions: number | null;     // lines added against HEAD; null for a binary file or when not counted
  deletions: number | null;
  binary: boolean;
};
type Diff =
  | { kind: "text"; diff: string }
  | { kind: "binary"; old_size: number | null; new_size: number | null }
  | { kind: "too_large"; limit: number };
type Branch = {
  name: string;                 // "main" for a local branch, "origin/main" for a remote one
  kind: "local" | "remote";
  tip: string;                  // the full hash of the commit the branch points at
  time: number;                 // the tip's committer time
  subject: string;              // the tip's subject line, at most 200 characters
  upstream: string | null;      // local only: the upstream's short name; null when there is none
  ahead: number | null;         // local only: null when there is no upstream
  behind: number | null;
  worktree: string | null;      // local only: another working tree that has this branch checked out
};
type Commit = {
  id: string;                   // the full hash
  parents: string[];            // full hashes, in order
  subject: string;              // at most 200 characters
  author: string;               // the author's name
  time: number;                 // the author time
  refs: { name: string; kind: "head" | "local" | "remote" | "tag" }[];
  side: "both" | "local" | "remote";
};
```

This is the desktop app's source control panel, from a phone: every repository under the owner's
folders in one list, what changed in each, one file's diff, and commit, push, pull and discard for
one repository at a time. As on the desktop there is no staging: a commit takes everything, and a
file's status and diff describe the working tree against `HEAD`, the staged and the unstaged part
together. The agent does all of it by running the `git` command line, and when git fails, what git
printed is what the owner reads.

#### Repositories and paths

- A repository is named by `repo`: the absolute path of the root of its working tree, in the form
  described under [Files](#paths) (it starts with `/`, is normalised, has no trailing `/`). The
  client only ever sends back a `path` that `git.repos` or `git.status` gave it. A `repo` that is
  missing or malformed fails with `bad_request`; one that is not the root of a working tree the
  agent lists (any more) fails with `not_found`.
- A file is named by `path`, relative to that root: segments separated by single `/`, none of them
  empty, `.` or `..`, no leading and no trailing `/`. Anything else fails with `bad_request`. Names
  are passed byte for byte; a file whose name is not valid UTF-8 is left out of `git.status`.
- The agent never runs git anywhere but in a working tree it lists itself.

#### Running git

- Git never waits for the owner: its standard input is closed or empty, `GIT_TERMINAL_PROMPT=0` is
  set, and no editor and no pager can open. A command that would need a password or a passphrase
  that no credential helper or agent supplies fails, and its message is carried like any other.
- Git's messages should be in English (`LC_ALL=C`, or the equivalent). What the owner is shown is
  always git's own text; the client only reads it to put a plain title over it (a rejected push, a
  pull that stopped at conflicts), and that reading is of English text.
- "Git's output" below means standard output and standard error together, in the order git wrote
  them as far as the agent can tell, decoded as UTF-8 with replacement characters, with white space
  trimmed from both ends, and cut to its last 16,384 bytes when it is longer.
- One command at a time changes a repository. `git.commit`, `git.push`, `git.pull`,
  `git.discard`, `git.switch`, `git.merge` and `git.merge_abort` for a `repo` that already has one
  of them running fail at once with `busy`; they are not queued. `git.repos`, `git.status`, `git.diff`, `git.branches`,
  `git.log` and `git.show` can be answered at any time.

#### `git.repos`

- The repositories are found from the folders of `workspace.list`: each folder's `directory` is
  searched for working trees, a working tree being a directory that holds a `.git` entry (a
  directory, or the file a linked worktree or a submodule has). The search goes on inside a working
  tree, so a repository nested in another one is listed too, each as a repository of its own. The
  linked worktrees of every repository found (`git worktree list`) are listed as well, wherever on
  disk they are. A bare repository has no working tree and is not listed.
- How deep the search goes and which directories it skips (`node_modules`, build output) is the
  desktop app's own business: the list is what its source control panel shows.
- A working tree is listed once. `root` is the `directory` of the folder it belongs to: of the
  folders whose directory is the working tree itself or holds it, the one with the longest
  directory. A linked worktree that lies outside every folder has the `root` of the repository it
  belongs to. The client groups and labels by `root`, with the folder's name from `workspace.list`.
- Order: by `root`, in the order of the folders in `workspace.list`, then by `path`, compared as
  strings. The client orders them differently for display.
- `branch`, `head`, `upstream`, `ahead`, `behind` and `changed` are what
  `git status --porcelain=v2 --branch -z --untracked-files=all` says: `branch.head` (`(detached)`
  gives `null`), `branch.oid` (`(initial)` gives `null`), `branch.upstream`, the two numbers of
  `branch.ab`, and the number of files as counted for `git.status`. When git prints an upstream but
  no `branch.ab`, the upstream is configured but no longer exists: `upstream` is then `null`, as if
  there were none. `ahead` and `behind` are against what was last fetched; the agent does not fetch.
- `is_worktree` is true when the working tree's git directory is not the repository's common one
  (`git rev-parse --git-dir` and `--git-common-dir` differ). `main_path` is then the directory that
  holds the common `.git`, or `null` when the worktree belongs to a bare repository.
- `operation` says what is unfinished in the working tree: `merge` when `MERGE_HEAD` exists in its
  git directory, `rebase` when `rebase-merge` or `rebase-apply` does, `cherry-pick` for
  `CHERRY_PICK_HEAD`, `revert` for `REVERT_HEAD`, in that order of precedence, else `null`.
- A working tree git cannot read is left out rather than failing the whole list. With no folders,
  or none that holds a repository, `repos` is empty.
- The client sends this request with `timeout_ms: 60000`, since a first search can be slow.

#### `git.status`

`files` are the files that differ from `HEAD`, as
`git status --porcelain=v2 --branch -z --untracked-files=all` reports them (`-z`, so that no name is
quoted; every untracked file by itself, not its directory; ignored files never). Each record maps
to at most one file, by its two status letters `XY`:

| Record | `status` |
|---|---|
| `u …` (unmerged) | `conflicted` |
| `? path` | `untracked` |
| `2 XY …` (renamed) with `Y` = `D` | `deleted`, with `path` set to the original path and `old_path: null` |
| `2 XY …` (renamed) otherwise | `renamed`, with `old_path` set to the original path |
| `2 XY …` with `X` or `Y` = `C` (copied) | `added`, `old_path: null` |
| `1 XY …` with `X` = `A` and `Y` = `D` | left out: `HEAD` never had the file and the working tree has not got it |
| `1 XY …` with `X` or `Y` = `D` | `deleted` |
| `1 XY …` with `X` or `Y` = `A` | `added` |
| every other `1 XY …` (`M`, `T`) | `modified` |

- A path that is both deleted in the index and present again as an untracked file is one file,
  `modified`.
- A rename is only what git itself reports as one: a file renamed in the index. A file that was
  moved without telling git is a `deleted` and an `untracked` file.
- An untracked directory that git reports as a whole, which it does for a repository nested inside
  this one and not ignored, is listed as `untracked` under its path without the trailing `/`, with
  `additions` and `deletions` `null`.
- `additions`, `deletions` and `binary` come from `git diff HEAD --numstat -M -z`: the two counts,
  or `null`, `null` and `binary: true` for a file git counts as binary (`-` in both columns). For
  an untracked file the agent counts the lines of the file itself (`deletions: 0`), and calls it
  binary when its first 8,000 bytes hold a NUL byte, as git does. The agent may answer `null` for
  both counts whenever counting would be costly; the client then shows none.
- In a repository without a commit, everything is compared with the empty tree instead of `HEAD`.
- Order: by `path`, compared code point by code point. At most 2,000 files are returned;
  `truncated` is `true` when there are more, and the files are then the first 2,000 in that order.
- `repo` is the repository as `git.repos` would describe it at the same moment, so the client can
  bring its list up to date; `repo.changed` counts every file, also beyond the limit.
- `merge` (round 3) says whether a merge is in progress: see [Merge state](#merge-state-in-gitstatus).

#### `git.diff`

The diff of one file against `HEAD`. `path` is a file's `path` from `git.status` and `old_path` its
`old_path` (the client sends `null` or leaves it out when there is none).

- For a file git tracks, `diff` is the standard output of

  ```
  git -c core.quotePath=false diff --no-color --no-ext-diff --no-textconv --unified=3 \
      --src-prefix=a/ --dst-prefix=b/ -M HEAD -- [<old_path>] <path>
  ```

  with `old_path` named only for a renamed file. For an untracked file it is the standard output of
  the same command with `--no-index -- /dev/null <path>` in place of `-M HEAD -- …`, which shows
  every line as added (git exits with status 1 there, which is not a failure). In a repository
  without a commit the empty tree stands in for `HEAD`. So staged and unstaged changes appear
  together, a deleted file shows every line removed, a file in conflict shows its conflict markers
  as added lines, and the options make the output independent of the owner's git configuration:
  three lines of context, `a/` and `b/` prefixes, names never quoted.
- The text is decoded as UTF-8; bytes that are not valid UTF-8 become U+FFFD. It is the diff of that
  one file: one header and its hunks. The client reads the hunks and nothing else from it, apart
  from `rename from`, `old mode` and `new mode` in the header.
- **No difference.** A path that exists (in `HEAD` or in the working tree) but does not differ gives
  `{ kind: "text", diff: "" }`. So does a rename, or a change of mode, without a changed line, with
  the header and no hunk in `diff`. The client says that nothing in the file's lines changed.
- **Binary.** When git prints `Binary files … differ` in place of hunks, the result is
  `{ kind: "binary", old_size, new_size }`: the size in bytes of the file in `HEAD`
  (`git cat-file -s HEAD:<old_path or path>`) and of the file in the working tree, each `null` when
  that side does not exist or the agent did not measure it.
- **Too large.** A diff longer than 1 MiB (1,048,576 bytes of standard output) gives
  `{ kind: "too_large", limit: 1048576 }` and no text. The client shows the file's `additions` and
  `deletions` from `git.status` instead.
- Errors: `not_found` when `path` is neither in `HEAD` nor in the working tree, `failed` with a
  sentence when `path` is a directory, `git_failed` with git's output when git fails.
- **In a commit.** `git.diff` takes an optional `commit`: `{ repo, path, old_path?, commit? }`.
  Without it nothing changes. With it, the result is that file's change in that commit against its
  first parent (or the empty tree), in the same three result kinds and size limit as today.
  The client sends the full hash of a commit that `git.log` or `git.show` gave it, with the `path`
  and `old_path` of a file that [`git.show`](#gitshow) listed for it.

#### `git.commit`

- Runs `git add -A` and then `git commit -F -` with `message` on standard input, in the repository's
  root: everything is staged, and one commit is made of it. `message` is passed exactly as given
  (git's default clean-up for a message that is not edited then drops leading and trailing blank
  lines and trailing spaces, and keeps lines that start with `#`). Hooks run as they do on the Mac.
- `message` is a string that is not empty once trimmed, of at most 64 KiB (65,536 bytes) in UTF-8;
  anything else fails with `bad_request`. The client refuses an empty message before sending.
- With an unfinished merge the same two commands conclude it. Since round 3 one safety rule comes
  first: while a merge is in progress, `git.commit` checks every path that is unmerged at that
  moment, and if any of those files still contains a conflict marker line (a line starting with
  `<<<<<<< `, a line that is `=======` exactly, or a line starting with `>>>>>>> `), it refuses
  with `conflict` and a message listing those paths (at most 20, then "and N more"), committing
  nothing. The message is the line `Conflict markers remain in:`, then one path per line
  (relative to the repository), then `and N more` on a line of its own when there are more than
  20; the client reads the paths from it to offer each file. Outside a merge `git.commit` is
  unchanged. An app from before round 3 (one whose `git.status` has no `merge` field) concludes
  the merge with the files as they are, conflict markers included, and the client warns before it
  sends that. The agent does nothing special for the other values of `operation`.
- Result: `commit` is the full id of the new commit (`git rev-parse HEAD`), `output` is git's output
  of both commands, and `repo` is the repository afterwards.
- When either command exits with a status other than 0 the answer is `git_failed` with git's output
  of both. That includes "nothing to commit", a hook that refuses, and a missing `user.name`.
- `conflict`: a merge is in progress and an unmerged file still holds a conflict marker line (see
  above), with the message described there.
- A commit never pushes. A client that offers "commit and push" sends `git.push` after `git.commit`
  has succeeded.

#### `git.push`

- With an upstream (`upstream` is not `null`), or with `HEAD` detached: `git push`. Git decides what
  that means from the owner's configuration, and says so when it refuses, which it does for a
  detached `HEAD`.
- Without one (`branch` is not `null` and `upstream` is `null`) the branch is published:
  `git push --set-upstream <remote> <branch>`, where `<remote>` is `origin` when the repository has
  a remote of that name and otherwise the first remote `git remote` lists. A repository with no
  remote at all fails with `failed` and a sentence that says so. `published` is `true` when the push
  was run this way, and `false` otherwise.
- Never with `--force` in any form, and never a second attempt: a rejected push is answered as
  rejected.
- Result: git's `output` (which git writes to standard error even when it succeeds) and the
  repository afterwards, with its new `upstream`, `ahead` and `behind`. A push that had nothing to
  send succeeds with git's `Everything up-to-date`.
- A status other than 0 is `git_failed` with git's output: a rejected push, no route to the remote,
  authentication refused.

#### `git.pull`

- Runs `git pull --no-edit`. Whether that merges or rebases is the owner's configuration, and when
  git refuses for want of one (`Need to specify how to reconcile divergent branches`), or because
  the branch tracks nothing, that is the answer.
- Result: git's `output` and the repository afterwards.
- A status other than 0 is `git_failed` with git's output. The agent leaves the repository as git
  left it: after a pull that stopped at conflicts the merge is unfinished (`operation: "merge"`),
  the files in conflict are `conflicted`, and nothing is aborted or resolved for the owner. The same
  holds for a pull that git refused because it would overwrite local changes, where nothing has
  changed.

#### `git.discard`

Throws changes away for good. The client asks the owner first, naming what will be lost; the agent
does not ask again.

- **Without `path`**, every change in the repository: `git reset --hard HEAD`, then `git clean -fd`.
  Tracked files go back to `HEAD`, files that were added but never committed and untracked files
  and directories are deleted, and an unfinished merge is abandoned. Ignored files stay (no `-x`),
  and so does a repository nested in an untracked directory, which `git clean` skips. In a
  repository without a commit this fails with `failed`: there is nothing to go back to.
- **With `path`**, that one file, by its `status`:
  - `untracked`: `git clean -f -- <path>`, which deletes the file.
  - every other status: `git restore --source=HEAD --staged --worktree -- [<old_path>] <path>`,
    with `old_path` named for a renamed file. That puts back a modified or deleted file, removes an
    added one (from the index and from disk), undoes a rename (the old file back, the new one gone)
    and gives a file in conflict its content from `HEAD`.
  - a `path` that does not differ from `HEAD` (any more) is not an error: nothing is done and the
    result is the repository as it is.
- Result: the repository afterwards. A status other than 0 is `git_failed` with git's output.

#### Branches and history

`git.branches`, `git.switch`, `git.log` and `git.show`, and the `commit` of `git.diff`, came after
the methods above; a desktop app from before them answers `not_supported` for the four, and the
client then offers neither the branch picker nor the graph while the rest keeps working.

`repo` is the absolute working-tree path of a discovered repository, as for the existing methods;
unknown repos answer `not_found`. Errors as the existing methods: `git_failed` with git's output
(last 16 KiB), `busy`, `not_found`, `bad_request`, `failed`. Times are whole milliseconds since the
epoch.

#### `git.branches`

`{ repo }` -> `{ current, detached, head, branches, truncated }`

- `current`: the checked-out local branch name, or null when detached; `detached`: boolean;
  `head`: the full hash of HEAD, or null in a repository with no commits.
- `branches`: `Branch[]`, local branches first, then remote-tracking branches; within each group
  newest tip first, ties by name. At most 500; `truncated` says whether more exist.
- `Branch = { name, kind: "local" | "remote", tip, time, subject, upstream, ahead, behind, worktree }`:
  `name` is `main` for local, `origin/main` for remote; `tip` the full hash; `time` the tip's
  committer time; `subject` the tip's subject line (at most 200 characters); for local branches
  `upstream` is the upstream's short name or null, `ahead`/`behind` are numbers or null when there
  is no upstream, and `worktree` is the absolute path of another working tree that has this branch
  checked out (null when none, and null for the working tree being asked about); for remote
  branches `upstream`, `ahead`, `behind` and `worktree` are null.
- Symbolic remote heads such as `origin/HEAD` are left out, and a remote branch is left out when a
  local branch has it as its upstream.
- A local branch whose upstream is configured but no longer exists is reported with
  `upstream: null`, and so with `ahead` and `behind` `null`.
- `worktree` is the path exactly as `git.repos` lists that working tree, so the client can lead
  from the branch to the repository that holds it.

#### `git.switch`

`{ repo, branch, kind }` -> `{ current, head }`

- `kind: "local"` runs `git switch <branch>`; `kind: "remote"` (branch is `origin/feature`) runs
  `git switch --track <branch>`; `kind: "new"` runs `git switch -c <branch>` from the current HEAD.
- `branch` must pass `git check-ref-format --branch` (otherwise `bad_request`), and must never be
  passed where git could read it as an option. A value that git would expand into another name,
  such as `@{-1}`, answers `bad_request` too.
- Never forced, never stashes, never discards: when git refuses (local changes would be
  overwritten, the branch is checked out in another worktree, the name exists), the answer is
  `git_failed` with git's message.
- Uses the same per-repo `busy` guard as commit and push. `git.changed` for that repo follows a
  successful switch.
- `git.changed` follows a switch that git refused as well, as it does for the other commands, so a
  client reads the repository again after a refusal too.
- The agent gives `git switch` the 240 seconds it gives the other commands that change a
  repository (see [Operations that take long](#operations-that-take-long)). The client waits 60
  seconds, so a checkout slower than that is answered by the relay with `timeout` while git
  finishes on the Mac. The client takes `timeout` on a switch to mean that it is still running,
  not that it failed, and reads the repository again when `git.changed` arrives.

#### `git.log`

`{ repo, limit, skip }` -> `{ commits, has_more, head, upstream }`

- History the way VS Code's source control graph shows it by default: the commits reachable from
  HEAD, plus those reachable from the current branch's upstream when it has one, newest first in an
  order where a child always comes before its parents (`--topo-order`).
- `limit` 1 to 200, default 50; `skip` 0 or more, default 0; `has_more` says whether older commits
  remain. `head` and `upstream` are the full hashes of HEAD and of the upstream tip (null when
  absent). An empty repository answers with no commits.
- `Commit = { id, parents, subject, author, time, refs, side }`: `id` full hash; `parents` full
  hashes in order; `subject` at most 200 characters; `author` the author name; `time` the author
  time; `refs: { name, kind: "head" | "local" | "remote" | "tag" }[]` for refs pointing at this
  commit (`head` is the entry for the current branch or the detached HEAD itself; `origin/HEAD` and
  stash refs are left out); `side: "both" | "local" | "remote"`: reachable from HEAD and the
  upstream, only from HEAD (not pushed yet), or only from the upstream (not pulled yet). Without an
  upstream every commit is `"both"`.
- In a repository that has no commit of its own yet but whose branch has an upstream, every commit
  is `"remote"`.
- `author` is the name after the repository's mailmap has been applied.

#### `git.show`

`{ repo, commit }` -> `{ commit, body, files, truncated }`

- `commit` is a full or abbreviated hash (hex, 4 to 64 characters; otherwise `bad_request`; unknown
  gives `not_found`). The result's `commit` is a `Commit` as above, `body` the message after the
  subject (at most 16 KiB), and `files` the files it changed against its first parent (against the
  empty tree for a root commit) in the same `File` shape `git.status` uses, with renames detected,
  capped at 2,000 with `truncated`.
- A commit that is reachable from neither HEAD nor the upstream has `side: "both"`.

#### Merging (round 3)

`git.merge` and `git.merge_abort` came after branches and history. An app from before them answers
`not_supported` for both; the client probes once per Mac connection by sending `git.merge` with
`repo: "?"`, which an app that has the method answers with `bad_request`, and offers merging only
then.

#### `git.merge`

`{ repo, branch, kind }` -> `{ outcome, head, conflicts, output }`

- Merges `branch` into the current branch. `kind` is `"local"` (a local branch) or `"remote"` (a
  remote-tracking branch such as `origin/feature`). An empty `branch`, or one holding a NUL, is
  `bad_request`; any other name that is not an existing `refs/heads/<branch>` or
  `refs/remotes/<branch>` respectively (`feature~1` included) is `not_found`. The branch is never
  passed where git could read it as an option. Merging the current branch into itself, or with a
  detached HEAD, is `bad_request`.
- The merge message is git's usual one for the short name (`Merge branch 'feature'`,
  `Merge remote-tracking branch 'origin/feature'`), not one that names the full ref
  (`Merge branch 'refs/heads/feature'`, which is what `git merge refs/heads/feature` writes).
- Runs `git merge --no-edit <full ref>`: git's default fast-forward behaviour, the default merge
  message, never `--force`, never a stash. Runs under the per-repo busy guard; `git.changed`
  follows.
- `outcome`: `"up_to_date"`, `"fast_forward"`, `"merged"` (a merge commit was made), or
  `"conflicts"` (git stopped with conflicts; this is NOT an error: the repository is left
  mid-merge, as git leaves it). `head` is HEAD's full hash afterwards. `conflicts` lists the
  unmerged paths (relative to the repo) when `outcome` is `"conflicts"`, else empty. `output` is
  git's output (last 16 KiB).
- When git refuses to start (for example local changes would be overwritten, or a merge or rebase
  is already in progress), the answer is `git_failed` with git's message and nothing changed. A
  merge that fails and leaves a merge in progress without any unmerged path is `git_failed` too.
- The client sends `timeout_ms: 300000`.

```ts
type GitMergeResult = {
  outcome: "up_to_date" | "fast_forward" | "merged" | "conflicts";
  head: string;
  conflicts: string[];
  output: string;
};
```

#### `git.merge_abort`

`{ repo }` -> `{ head }`

Runs `git merge --abort`. When no merge is in progress: `bad_request`. Busy guard; `git.changed`
follows. `head` is HEAD's full hash afterwards.

#### Merge state in `git.status`

`git.status` results gain an optional field `merge`: `null` when no merge is in progress, else
`{ branch, message, conflicts }`:

- `branch`: the name being merged when git records it (from `MERGE_MSG`'s first line, best effort,
  may be `null`). It comes from a message and may name a branch that does not exist (any more);
  the client shows it and never looks it up;
- `message`: the prepared merge message from `.git/MERGE_MSG` with comment lines removed and
  trimmed;
- `conflicts`: the unmerged paths, relative to the repository.

An app that has round 3 always sends the field; older apps omit it, which is how the client tells
that the commit safety rule of [`git.commit`](#gitcommit) is not there.

```ts
type GitMergeState = { branch: string | null; message: string; conflicts: string[] } | null;
```

#### Finishing a merge

The existing `git.commit` finishes a merge (it already runs `git add -A` then commits, which
concludes the merge), with the safety rule described under [`git.commit`](#gitcommit). The client
offers "Commit merge" with `merge.message` prefilled.

#### Operations that take long

`git.commit` (hooks), `git.push` and `git.pull` (the network), `git.discard` and `git.merge` (hooks,
a large tree) can outlast the 20 seconds the relay gives a request. For these five the client sends
`timeout_ms: 300000` (see [Frames](#frames)), and the agent simply answers when git has finished: no
progress, no second frame. The agent, for its part, does not let git run for ever: a command of
these five that is still running after 240 seconds is stopped, and the answer is `git_failed` with what git printed up
to then and a last line saying that it was stopped. So the agent always answers before the relay
gives up.

The client sends `timeout_ms: 60000` for `git.switch` and the default for `git.branches`,
`git.log`, `git.show` and `git.merge_abort`.

If the client's connection drops in the meantime, the relay forgets the request and the answer is
lost, while the command runs on to its end on the Mac. The client then reads the outcome from the
repository itself (`ahead`, `behind`, `changed`, `operation`) the next time it lists. It never
sends a command again by itself.

#### Event `git.changed`

`{ repo }`, sent to all clients. `repo` is the `path` of a repository whose `Repo` or files may
differ from what the agent last answered; `null`, or a missing `repo`, means that any of them may,
or that the set of repositories itself changed. The client reads again whatever it is showing: the
list, that repository's files, its branches and its graph, an open diff.

The event is optional. An agent that sends it does so at most once a second per repository, after
each `git.commit`, `git.push`, `git.pull`, `git.discard`, `git.switch`, `git.merge` and
`git.merge_abort` (failed ones included, since a failed pull changes files too), and, if it watches
the working trees, when something changed them from outside. A client must not depend on it: it also reads again when the screen is opened, when the
owner asks, after each of its own commands, and when the page comes back to the foreground.

#### Errors

The source control methods add these codes to the ones under [Frames](#frames):

| Code | Meaning |
|---|---|
| `git_failed` | Git ran and exited with a status other than 0, or was stopped. `message` is git's output as defined above, several lines of it, which the client shows as it is. |
| `busy` | Another `git.commit`, `git.push`, `git.pull`, `git.discard`, `git.switch`, `git.merge` or `git.merge_abort` is still running in this repository. |
| `conflict` | `git.commit` during a merge: an unmerged file still holds a conflict marker line. `message` names the files. |
| `not_found` | `repo` is not a working tree the agent lists, `path` (for `git.diff`) names nothing, or `commit` is not a commit of the repository. |
| `bad_request` | A malformed `repo`, `path` or `commit`, an empty or oversized `message`, a `branch` that is not a branch name, or an unknown `kind`; `git.merge` of the current branch or with a detached HEAD; `git.merge_abort` with no merge in progress. |
| `failed` | The agent could not do it and git was not the one to say why. `message` is a sentence for the owner. |

A client that does not know a code treats it as `failed`. An agent without these methods answers
`not_supported`, as for any unknown method, and the client tells the owner to update Hako on the
Mac.

### Notifications (sprint 6)

The desktop app tells the owner's devices that a terminal wants them: a coding agent is waiting,
a coding agent has finished, a long command has finished. It does so with one event, `notify`. The
relay decides which of them go out, shows them to the clients that are open, and sends each as a
[Web Push](https://www.rfc-editor.org/rfc/rfc8030) message to the devices that asked for
notifications, where a tap opens that terminal.

#### Event `notify` (agent to relay)

```jsonc
{
  "t": "evt",
  "event": "notify",
  "data": {
    "kind": "agent_waiting",
    "title": "Claude Code needs your permission",
    "body": "Allow Bash: pnpm test?\nfix login copy in hako-remote",
    "session_id": "…",
    "tab_id": "…"
  }
}
```

| Field | Type | Meaning and limits |
|---|---|---|
| `kind` | string | `agent_waiting`, `agent_done`, `command_done` or `preview_ready` ([Previews](#event-notify-kind-preview_ready)). Required. |
| `title` | string | One line of plain text, at most 100 characters. Required, and not empty. |
| `body` | string | Plain text of at most 300 characters, which may hold line breaks (`LF`). May be `""`; a missing `body` counts as `""`. |
| `session_id` | string | The terminal the notification is about: the `session_id` of its pane in `workspace.list`. Required, 1 to 255 bytes in UTF-8. |
| `tab_id` | string or `null` | The `id` of the tab that holds that pane, at most 255 bytes. `null`, or leaving it out, means the agent does not know it. |

- A character is a Unicode scalar value, which is what `chars().count()` counts in Rust.
- **Plain text only.** `title` and `body` are shown as they are, on a lock screen among other
  places: no HTML, no Markdown, no terminal escape sequences. The agent writes them for a person,
  in the language of the app, and keeps them within the limits itself.
- The text leaves the Mac, passes through the relay and through the push service of each device's
  maker (encrypted for the device, see [the push message](#the-push-message)), and can be read on
  a locked phone. The agent puts in what the terminal's title bar and the agent's status line
  already show, and never the output of the terminal.
- The agent gets no answer to a `notify`, as to any event.

What the relay does to the text before using it, so that nothing a terminal printed can disturb a
notification:

- `title`: every control character (U+0000 to U+001F, U+007F to U+009F), the line and paragraph
  separators (U+2028, U+2029) and the direction marks (U+200E, U+200F, U+202A to U+202E, U+2066 to
  U+2069) becomes a space; every run of white space becomes one space; the ends are trimmed. A
  title longer than 100 characters is cut to its first 99 and `…`.
- `body`: `CR LF` and `CR` become `LF`; each line is cleaned as a title is; blank lines at the
  start and the end are dropped, and several blank lines in a row become one. A body longer than
  300 characters is cut to its first 299 and `…`.

A `notify` is **dropped**, with a line in the relay's log, when its `data` is not an object, when
`kind` is none of the four, when `session_id` is missing, not a string, empty or longer than 255
bytes (`preview_ready` excepted, see [Previews](#event-notify-kind-preview_ready)), or when `title` is not a string or is empty once cleaned. A `tab_id` that is not a string of
1 to 255 bytes is read as `null`. So a newer desktop app may send a kind this relay does not know,
and nothing happens.

#### Kinds, and when the desktop app sends each

| `kind` | Sent when |
|---|---|
| `agent_waiting` | The coding agent in a terminal starts waiting for the owner: it asks for a permission, asks a question, or has stopped and waits for the next instruction. This is the moment the pane's `agent.status` in `workspace.list` becomes `waiting`. While the status stays `waiting`, it is sent again only when the agent's `message` changes, which is a new question. |
| `agent_done` | The pane's `agent.status` becomes `done` or `failed`. The title says which. |
| `command_done` | A command the owner ran at the shell prompt of a terminal finishes after running for 30 seconds or longer, whatever its exit status. Thirty seconds is the default of a setting the desktop app may offer. Not sent for a command during which the pane reported an agent status (the agent's own events have said it), and not for a terminal in which the app cannot tell where a command begins and ends. |

Rules for all three:

- **The desktop app sends them whether or not anyone is listening.** It does not know whether a
  client is connected, and it must not look at whether the owner is at the Mac, whether Hako is
  the frontmost app, or whether that terminal is on screen. Whenever the event happens and the app
  is connected to the relay, it sends the `notify`. Which devices hear about it is decided by the
  relay and by each device's own switches.
- One `notify` for each event. The agent need not hold back repeats: the relay collapses them
  (below). It must not send a `notify` on a timer, as a reminder, or for a state that has not
  changed.
- When the app is not connected to the relay at that moment, it may keep the newest `notify` of
  each session and send it after reconnecting if it is then no more than 60 seconds old. Older
  ones are dropped; nothing is replayed.
- For `agent_waiting` and `agent_done`, `workspace.list` already answers with the pane's new
  `agent` when the `notify` is sent, and `workspace.changed` is sent as for any other change. The
  two events may come in either order: a client reads the workspace again when it sees a `notify`,
  so the list and the notification agree.
- A `session_id` the workspace no longer lists is not an error. The notification is delivered, and
  a tap on it ends in the workspace.

The wording is the desktop app's. This is what the mock agent sends, and what the client is laid
out for: a title that names who and what, and a body whose first line is the detail and whose
second says where.

| `kind` | `title` | `body` |
|---|---|---|
| `agent_waiting` | `Claude Code needs your permission`, `Claude Code has a question`, `Claude Code is waiting for you` | The agent's `message` (`Allow Bash: pnpm test?`), then a line `<tab title> in <folder name>`, or the tab's title alone outside a folder. |
| `agent_done` | `Claude Code has finished`, `Claude Code failed` | The agent's `message`, then the same line. |
| `command_done` | `<the command line> finished`, `<the command line> failed`, with a long command line cut by the app | `Took 2 min 14 s, exit status 0`, then the same line. |

#### The collapse rule

The relay lets through, for one session and one kind, at most one `notify` in any 5 seconds. With
"delivered" meaning that it went on to the clients and the devices:

1. A `notify` whose session and kind had none delivered in the last 5 seconds is delivered at
   once. If one was being held for that session (rule 3), the held one is dropped: it is older.
2. A `notify` that arrives within 5 seconds of the last delivered one of its session and kind, with
   the same `title` and `body` as that one, is dropped.
3. A `notify` that arrives within those 5 seconds with a different `title` or `body` is held. The
   relay holds one `notify` for each session, the newest: a later one that has to wait replaces
   it, whatever its kind. When the 5 seconds since the last delivered one of the held one's kind
   are over, it is delivered, and its own 5 seconds begin.
4. Different kinds do not hold each other back, and neither do different sessions:
   `agent_waiting` followed a second later by `agent_done` for the same terminal are both
   delivered at once.
5. Over all sessions together the relay delivers at most 20 in any 60 seconds. What exceeds that
   is dropped and logged.

Time is the relay's, measured at arrival. Four `agent_waiting` for one terminal at 0 s, 0.3 s,
0.6 s and 0.9 s with four different questions end as two notifications: the first at 0 s and the
fourth at 5 s.

On a device, every notification of a terminal carries the same `tag`, so a newer one takes the
place of the older one instead of piling up: the `agent_done` of rule 4 replaces the
`agent_waiting` before it.

#### What the relay does with it

1. It reads and cleans the event, or drops it, as described above.
2. It applies the collapse rule.
3. It sends what is delivered to **every connected client** as an event of the same name, with the
   cleaned fields and nothing else: `{ kind, title, body, session_id, tab_id }`, where `tab_id` is
   a string or `null`. Unlike other events from the agent, a `notify` reaches the clients only
   through these three steps, never as the agent sent it.
4. It sends it as a push message to **every stored subscription** whose login session is still
   valid, that is not muted, and that has this kind switched on.

The relay keeps no notification. One that is delivered while no client is connected is not shown
to a client that connects later, and a device that is off gets, from its push service, the newest
notification of each terminal that is less than 4 hours old.

Sending never holds the relay up: step 4 only starts the requests. Each waits at most 10 seconds
for the push service. A subscription the push service answers with `404` or `410` is removed. Any
other failure is logged, with the push service's host name and a short hash that stands for the
subscription, never its address or its keys, and is not tried again.

#### The push message

Each push is one HTTP `POST` to the subscription's `endpoint`, encrypted for that browser with
`aes128gcm` ([RFC 8291](https://www.rfc-editor.org/rfc/rfc8291)) and signed with the relay's VAPID
key ([RFC 8292](https://www.rfc-editor.org/rfc/rfc8292)). The push service sees the headers and
the size; the text it carries can be read only by the device.

| Header | Value |
|---|---|
| `TTL` | `14400`: the push service keeps the message for 4 hours for a device it cannot reach. |
| `Urgency` | `high` for `agent_waiting`, `normal` for the other two. |
| `Topic` | The first 32 characters of the base64url SHA-256 of `session_id`, so that a push service holding messages for an unreachable device keeps one for each terminal, the newest. |

The decrypted payload is JSON:

```ts
type PushPayload = {
  v: 1;
  kind: "agent_waiting" | "agent_done" | "command_done" | "preview_ready" | "test";
  title: string;
  body: string;
  session_id: string | null;   // null for a test
  tab_id: string | null;
  preview_id?: string;         // preview_ready only
  tag: string;                 // "hako:" + session_id, "hako:preview:" + preview_id, or "hako:test"
};
```

It is at most 3,072 bytes; a `body` that would make it longer is cut further.

The client's service worker (`/sw.js`) shows a notification for every push it receives, also for
one it cannot read (an iPhone withdraws the permission from an app that receives pushes without
showing anything), with the `tag` as the notification's tag. On a tap it focuses an open window of
the app and tells it which terminal to show, or opens the app at `/#/t/<session_id>`. The app reads
the workspace again and, when that terminal is gone, shows what its tab still holds if `tab_id`
names a tab that is still open, and otherwise the workspace, with a line that says why. The worker
answers no request and caches nothing.

#### Devices: the push routes of the relay

A device is one browser, or one home-screen app, that is logged in: the relay keeps at most one
push subscription for each login session. All six routes need the session cookie (`401` without
one) and, being under `/api`, a `POST` must come from the app's own origin (`403` otherwise).

```ts
type Kinds = {
  agent_waiting: boolean;
  agent_done: boolean;
  command_done: boolean;
  preview_ready: boolean;
};
type Device =
  | { subscribed: false }
  | { subscribed: true; endpoint_id: string; muted: boolean; kinds: Kinds };
```

`endpoint_id` is the SHA-256 of the subscription's `endpoint` in lower-case hex. It lets a client
see whether the relay holds the subscription its browser has, without the relay giving the address
back.

| Route | What it does |
|---|---|
| `GET /api/push/key` | `{ key }`: the VAPID public key, an uncompressed P-256 point in base64url without padding, which the client passes to `PushManager.subscribe` as `applicationServerKey`. |
| `GET /api/push/device` | The `Device` of this session. |
| `POST /api/push/subscribe` | Body: what `PushSubscription.toJSON()` gives, `{ endpoint, keys: { p256dh, auth } }`, with the optional `muted` (boolean) and `kinds` (any of the four, booleans) beside them. Stores it for this session in place of whatever the session had, and answers with the `Device`. With neither `muted` nor `kinds` the session's earlier preferences are kept; a first subscription starts unmuted with every kind on, and a kind left out of `kinds` is on. `endpoint` must be an `https:` address of at most 2,048 characters without a user name, `p256dh` must decode to 65 bytes that start with `0x04`, and `auth` to 16 bytes; anything else is `400 bad_request`. (A relay that is itself served without TLS, which is a development setup, also takes `http://localhost` and `http://127.0.0.1`.) |
| `POST /api/push/settings` | Body: `{ muted?, kinds? }`. Changes the fields that are given and answers with the `Device`. `404 not_subscribed` when the session has no subscription; `400 bad_request` for a value that is not a boolean. |
| `POST /api/push/unsubscribe` | Removes this session's subscription, if any. `{ ok: true }`. |
| `POST /api/push/test` | Sends this device, and no other, a notification with `kind: "test"`, also when it is muted, and waits for the push service. `{ ok: true }` when the push service took it. `404 { error: "not_subscribed" }` without a subscription. `410 { error: "gone" }` when the push service said the subscription no longer exists, which has also removed it. `502 { error: "push_failed", status, reason }` for any other refusal, with the push service's status and the start of what it answered, or with `status: null` when it could not be reached. |

A subscription is also removed when its session ends: at `POST /api/logout`, for every other
session at `POST /api/password`, and when a session expires.

The VAPID key pair is made on the relay's first start and kept in its database, so a relay needs
no setting for notifications. `VAPID_PUBLIC_KEY` and `VAPID_PRIVATE_KEY` in the environment, both
in base64url, take its place when set. The contact the relay names to push services is
`mailto:` and the owner's email address, or `VAPID_SUBJECT`. When the key changes, a client finds
that its browser's subscription was made for another key and replaces it.

#### What the client does

- Each time the app opens with the permission granted, it brings three things into agreement
  without asking anything: the browser's subscription (made if missing, remade if it belongs to
  another key), the relay's copy of it (stored again if `GET /api/push/device` shows none, or
  another `endpoint_id`), and the preferences. So a subscription the relay lost comes back by
  itself.
- The preferences (`muted`, `kinds`) belong to the device. The client keeps them, sends them with
  a subscription, and changes them with `POST /api/push/settings`.
- When a `notify` event arrives while the page is visible, the client shows it in a banner unless
  the device is muted, has the kind off, or is already showing that terminal. The system's
  notification arrives as well.
- Logging out removes the relay's copy and then ends the browser's subscription.

### Previews (round 4)

A preview is a web app the desktop app runs for the owner, usually a dev server that Claude Code
started in a Hako tab. The owner opens it on the phone, inside the web app, as if on the Mac. The
desktop app keeps the list of previews and opens TCP connections to their ports on request; the
relay gives every port of every preview its own origin and passes HTTP and WebSockets to the dev
server over byte streams on the agent's WebSocket.

#### Addresses

- With the app at `https://hako.example.com`, previews live under the **preview domain**
  `hako.example.com`: the relay's `PREVIEW_DOMAIN`, or the host name of the first `PUBLIC_ORIGIN`
  when that is not set. Preview origins have the app's scheme and port. A `PUBLIC_ORIGIN` whose
  host is an IP address means no previews.
- The preview `myapp` is served at `https://myapp.hako.example.com` (its **main port**), and each
  of its other ports `P` at `https://myapp--P.hako.example.com`. `myapp--<main port>` is not an
  origin of it; the main port has its own name only.
- A preview id is 1 to 40 characters of `[a-z0-9-]`, does not start or end with `-`, does not
  contain `--`, and is none of `www`, `api`, `app`, `admin`, `relay`, `hako`, `mail`, `static`,
  `assets`.
- A request whose `Host` is under the preview domain never reaches the app's own routes (`/api/*`,
  `/ws/*`, the web app), and a request for the app never reaches a preview. The relay reads the
  first label of `Host` (port and case ignored); a label that is not `<id>` or `<id>--<port>` with
  a valid id and a port of 1 to 65535 gets the 404 page "No preview called <label>".
- On one computer, use the `.localhost` names browsers resolve to 127.0.0.1 without DNS:
  `PUBLIC_ORIGIN=http://hako.localhost:8787` puts previews at `http://myapp.hako.localhost:8787`.
  Use a domain under `localhost`, not `localhost` itself: Chrome treats `myapp.localhost` and
  `localhost` as different sites, so the app's frame would not carry the preview cookie, and it
  takes no cookie for `Domain=localhost`.

#### Who can open a preview

Only the owner, and only from the app: preview origins never receive or read the login session
cookie.

- The session cookie is `__Host-hako_session` (Secure, host-only, `Path=/`, HttpOnly,
  SameSite=Lax) when every `PUBLIC_ORIGIN` is HTTPS, and `hako_session` without `Secure`
  otherwise. Being host-only it never reaches a preview origin, and the `__Host-` prefix keeps a
  preview from setting or replacing it for the app. A relay served over HTTPS reads that name only;
  `hako_session` is read only over plain HTTP.
- `POST /api/previews/ticket` `{ id, path? }`, with the session cookie and the app's `Origin` like
  every `POST` under `/api`, answers `{ url }`:
  `https://<id>.hako.example.com/__hako/auth?t=<ticket>&next=<path>`. `path` is where to go once
  in, a path on the preview's own origin (starting with one `/`, no backslash or control
  character, at most 2,048 characters), `/` when left out. `400 bad_request` for an id or a path
  that is not valid, `401` without a session, `404 { error: "previews_off" }` on a relay without a
  preview domain. The relay does not ask the Mac whether the preview exists.
- A ticket is 32 random bytes (base64url), good for one use within 60 seconds, for that preview
  only, and bound to the login session that asked for it. The relay keeps tickets in memory only.
- `GET /__hako/auth?t=<ticket>&next=<path>` on the preview's origin uses up the ticket (also when
  it is shown at another preview, which then refuses it) and, when it is valid and its session
  still live, answers `303` to `next` (`/` when `next` is not a valid path) with the **preview
  cookie**: `__Secure-hako_preview=<value>; Domain=hako.example.com; Path=/; Max-Age=43200;
  HttpOnly; SameSite=Lax; Secure`. Over plain HTTP its name is `hako_preview`, without `Secure`.
  Otherwise it answers the 401 page.
- The preview cookie covers every preview origin, of every preview: it is bound to the owner's
  login session, not to a preview. Its value is `<session hash>.<expiry in ms, base 36>.<HMAC>`,
  signed with a key derived from `HAKO_SESSION_SECRET` that signs nothing else. It is refused when
  it is forged, expired (12 hours), or when its session has ended (logout, password change,
  expiry), and the WebSockets a session opened to previews are closed when it ends.
- Every other request to a preview origin without a valid preview cookie gets `401` with a small
  HTML page "Open this preview from Hako", and so does a WebSocket handshake. The preview cookie is
  removed from the `Cookie` header of every request passed to a dev server.

#### The registry

```ts
type Preview = {
  id: string;
  name: string;              // for the owner: "Web app"
  directory: string;         // absolute
  repo: string | null;       // the git working tree, or null
  port: number;              // the main port
  ports: { port: number; label: string }[];  // every port the browser may need, the main one included
  command: string | null;    // the dev command, or null for a server attached while running
  tab_id: string | null;     // the Hako tab running it
  session_id: string | null; // that tab's terminal
  status: "starting" | "running" | "stopped" | "failed";
  message: string | null;    // a short sentence for failed and stopped
  started: number;           // ms
  url_path: string;          // the path to open first, "/" by default
};
```

| Method | Params | Result |
|---|---|---|
| `preview.list` | `{}` | `{ previews }`, newest first. |
| `preview.stop` | `{ id }` | `{}`. Sends Ctrl+C to the preview's tab, which stays open with its output; the status becomes `stopped` when the port stops answering or the process exits. |
| `preview.restart` | `{ id }` | `{}`. Stops it as above if it runs, then runs the command again in the same tab, or in a new one when that tab was closed. |
| `preview.remove` | `{ id }` | `{}`. Stops it, forgets it and closes its tab. |

`not_found` for an id the app does not have. An app without previews answers `not_supported`;
`preview.list` is the probe. The client asks the last two with `timeout_ms` of 60,000.

Event `previews.changed` `{}` whenever the list or a status changes, at most twice a second. The
relay passes it on to clients like any event, and reads the list again itself.

The relay calls `preview.list` too (with a `relay:` id): when the agent has been announced, after
each `previews.changed`, and when asked for a preview it does not know, at most every 2 seconds. It
uses the answer for the port numbers, and to tell an unknown preview (404) from a stopped one
(503). An answer of `not_supported` is an empty list.

#### Byte streams

A stream is one TCP connection the Mac makes to one port of a preview, for the relay. Its messages
travel on the agent's WebSocket beside the others; they are not requests, have no ids to rewrite
and no timeouts of the request kind.

```jsonc
// relay -> agent: connect to 127.0.0.1:<port>, or [::1]:<port> when IPv4 is refused
{ "t": "sopen", "sid": 7, "preview": "myapp", "port": 8087 }
// agent -> relay: connected
{ "t": "sopened", "sid": 7 }
// either way: no more data from me on this stream
{ "t": "sclose", "sid": 7 }
// either way: the stream failed and is gone
{ "t": "sclose", "sid": 7, "error": { "code": "failed", "message": "connect ECONNREFUSED" } }
// either way: I have passed on this many more bytes of yours
{ "t": "sack", "sid": 7, "bytes": 65536 }
```

- `port` must be one of the preview's `ports`. The agent refuses with `sclose` and `error.code`
  `not_found` for an unknown or stopped preview or a port it does not list, and `failed` when
  nothing answers on the port, over IPv4 or IPv6. A dev server on a Mac often listens on
  `localhost` and so on `::1` only (Vite does), which is why both are tried.
- Data is a binary frame of type `0x02`:

  ```
  byte 0       0x02
  bytes 1..4   sid, unsigned 32-bit big-endian
  rest         payload, at most 64 KiB is sent per frame
  ```

  The terminal output frame (`0x01`) is unchanged; a relay routes by the first byte.
- `sclose` without `error` is a half-close, as TCP's FIN: the sender sends no more, and the other
  side may go on sending. The stream is gone when both sides have sent `sclose`, or when either
  sends one with `error`. The agent passes a half-close on to the TCP socket (`end`) and sends
  its own `sclose` when the dev server closes its side.
- When the TCP connection is gone (reset, or closed altogether) while the relay's side is still
  open, the agent sends `sclose` with `error` after the data it already read, so the relay does
  not wait for an answer on a dead connection. The relay closes its side once the agent has closed
  its own, as a TCP client does, so a kept-alive connection that the dev server dropped is not
  used again.
- Flow control: each side has at most 512 KiB of payload per stream in flight, sent and not yet
  acknowledged, and stops sending on that stream when the window is full. The receiver sends
  `sack` with the number of bytes it has passed on, to the TCP socket or to the browser, at least
  every 32 KiB and whenever it has passed on everything it holds. More than the window, or an
  `sack` for more than was sent, ends the stream with `error`. A slow phone or a fast dev server
  so holds at most a window per stream in the relay and in the app.
- `sid`s are chosen by the relay, unique among its open streams. When the agent connection drops,
  every stream ends on both sides.
- The relay opens at most 64 streams per preview, closes one after 120 seconds without data
  either way unless it carries a WebSocket, and gives the agent 10 seconds to answer `sopen`.

#### HTTP and WebSockets over streams

The relay speaks HTTP/1.1 to the dev server over streams, one stream per connection, keeping
connections alive between requests; WebSocket handshakes go the same way, after which bytes are
passed both ways untouched. Any method is passed on.

The relay maps each port's local addresses to its preview origin and back: `http://localhost:P`,
`http://127.0.0.1:P` and `http://[::1]:P` (and `https:`, `ws:` and `wss:` forms) stand for the
preview origin of `P`, for every `P` in the preview's `ports`. Other ports are left alone.

Requests, on their way to the dev server:

- `Host: localhost:<port>`, so host checks made for localhost (Vite's `allowedHosts`, Next's
  `allowedDevOrigins`) pass.
- `Origin` and `Referer` that are origins of the same preview become their localhost form: a
  request from the main origin to the API's origin arrives with `Origin: http://localhost:8086`,
  as on the Mac. Other origins pass unchanged.
- `X-Forwarded-Host` (the preview host), `X-Forwarded-Proto` (`https`) and `X-Forwarded-For`
  (what came in, then the address the relay saw) are set; `Forwarded` and `X-Forwarded-Port` are
  removed.
- `Accept-Encoding` is removed, so pages arrive uncompressed and can take the client script.
- The preview cookie is removed from `Cookie`; hop-by-hop headers are removed.
- Bodies of at most 50 MiB (`413` with a page beyond).

Responses, on their way to the browser:

- `Location`, `Content-Location`, `Access-Control-Allow-Origin`, the URL in `Refresh` and each
  URL in `Link` are mapped from localhost form to preview origin.
- **Cookies are shared across the preview domain.** On the Mac a cookie set by `localhost:8087` is
  sent to `localhost:8086` too, since cookies ignore ports; here each port is its own host. So
  every `Set-Cookie` gets `Domain=hako.example.com` in place of any `Domain` it had (a
  `__Host-` cookie, which cannot have one, keeps its origin). Like localhost on a Mac, the preview
  domain is then shared by every port of every preview. A `Set-Cookie` for the preview cookie or
  the session cookie is dropped.
- `X-Frame-Options` is removed, any `frame-ancestors` is removed from `Content-Security-Policy`
  (and `-Report-Only`), and every response gets
  `Content-Security-Policy: frame-ancestors <the app's origins>`: a preview can be framed by the
  app and by nothing else, another preview included.
- Hop-by-hop headers are removed. Everything else passes unchanged, and bodies stream as they
  come: server-sent events are not held back.
- A `text/html` answer that is not compressed, with a body, whose enforced CSP allows a script
  from its own origin (`script-src-elem`, else `script-src`, else `default-src` holding `'self'`,
  `*`, the scheme, or a host source matching the origin, and not `'strict-dynamic'`), gets
  `<script src="/__hako/client.js?p=<id>&v=<version>"></script>` as the first thing in `<head>`,
  with no `defer` or `async`, so it runs before the page's own scripts. Without a `<head>` within
  the first 64 KiB, it goes after `<html …>`, else after the doctype (before it would switch the
  page to quirks mode), else at the very start. `Content-Length` is corrected. A page whose CSP
  would block the script is left as it is.

The pages a preview origin answers with itself, all small HTML with `Cache-Control: no-store`:

| Status | Page | When |
|---|---|---|
| 401 | Open this preview from Hako | No valid preview cookie; a used, expired or foreign ticket. |
| 404 | No preview called `<id>` | An invalid or reserved label, or an id the Mac does not have. |
| 404 | No port `<P>` in `<id>` | A port the preview does not list. |
| 503 | Your Mac is offline | The agent is not connected. |
| 503 | This preview is stopped | The preview is `stopped` or `failed` (with its `message`), or the agent answered `not_found`. |
| 503 | This preview is starting | It is `starting` and nothing answers yet; the page reloads itself after 3 seconds. |
| 503 | Nothing answers on port `<P>` | It is `running` and the connection failed. |
| 503 | Too many connections | The preview has 64 streams. |

The relay pings each tunnelled WebSocket every 25 seconds while the dev server is quiet, between
two frames, so proxies keep it open; the browser's pong reaches the dev server, which ignores it.

#### `/__hako/client.js`

Served by the relay itself on every preview origin, with the preview cookie, and never tunnelled.
It holds the app's origins and the preview's port map, and it:

- maps a URL in a mapped localhost form to its preview origin before it reaches the network, in
  `fetch` (string, `URL` and `Request`), `XMLHttpRequest.open`, `WebSocket`, `EventSource`,
  `navigator.sendBeacon`, `window.open`, `Location.assign`/`replace` where a browser lets them be
  replaced, the `src`, `srcset`, `href`, `action`, `poster` and `data` attributes of elements
  already there and added or changed later (one `MutationObserver`), and links and forms on click
  and submit (capture phase). A parser-inserted element starts loading before the observer sees
  it, so a page that writes such an address in its HTML loads it once from the original address.
- When framed, reports to `window.parent`, by `postMessage` to the app's origins only:

  ```ts
  { type: "hako:preview", kind: "location", url, title, width, height }
  // on load, on every history change (pushState, replaceState, popstate, hashchange), on resize,
  // and when the title changes; width and height are innerWidth and innerHeight
  { type: "hako:preview", kind: "console", level: "error" | "warn", message, source, line }
  // console.error and console.warn, uncaught errors, unhandled rejections; at most 50 per page
  // load, each text at most 2,000 characters; source and line may be null
  ```

- Takes from its parent, only when the message comes from `window.parent` and one of the app's
  origins: `{ type: "hako:preview", kind: "back" | "forward" | "reload" }` and
  `{ type: "hako:preview", kind: "navigate", path }` (a path on the same origin).

The app shows a preview in a frame loaded from a fresh ticket URL; its CSP allows
`frame-src <scheme>//*.<preview domain><port>`.

#### Event `notify`, kind `preview_ready`

The desktop app sends a `notify` of kind `preview_ready` when a preview becomes `running`:
`title` "Preview ready: <name>", `body` the directory, `session_id` and `tab_id` of its tab, and
`preview_id`, the preview's id. For this kind only, `session_id` may be `null` or left out (a
preview attached while running has no tab), and `preview_id` is required (a `preview_ready`
without a valid one is dropped). Clients receive `preview_id` with the other cleaned fields, only
for this kind. The collapse rule counts a preview without a tab as its own subject
(`preview:<id>`). The push message carries `preview_id` too; its tag is `hako:<session_id>`, or
`hako:preview:<id>` without a tab. Each device has a switch for this kind (`kinds.preview_ready`,
on by default), and a tap opens the preview's viewer (`/#/p/<id>`).

## Versioning

`app.info.protocol` is 1. A method the agent does not know returns `not_supported`, so a newer client
can run against an older app and hide what is missing.
