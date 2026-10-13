# Hako Remote

A phone-first web app, and the relay server behind it, for seeing and controlling the
[Hako](https://github.com/egehakan/hako) terminal on your Mac from a browser: which folders and tabs
are open, what each terminal is running, and whether a coding agent in one of them is working,
waiting for you or done. You can open a terminal in a folder, bring a tab to the front and close
one, and you can use any of those terminals live: a shell, or a full-screen program such as Claude
Code, with the keys a phone keyboard lacks. You can also browse the folders of your projects, read a
file with syntax colours, and make a small edit and save it; and you can see what changed in every
repository in those folders, read the diffs, and commit, push and pull. And your phone is told
when an agent is waiting for you or has finished, and when a long command is done.

Hako Remote is a companion to [Hako](https://github.com/egehakan/hako), a personal terminal that is
based on Warp. Neither project is affiliated with, or endorsed by, Warp.

## How it works

There are three parties, and the contract between them is [docs/protocol.md](docs/protocol.md).

The **agent** is the Hako desktop app. It never listens on the network. It dials out to the relay
over a WebSocket, proves itself with a shared key, and then answers requests: list the workspace,
create a tab, close a tab, attach to a terminal, list a directory, read and write a file, run git
in a repository.

The **relay** is the server in this repository, a single Node process. It serves the web app, keeps
the one account and its login sessions in SQLite, and passes messages between the agent and any
number of browsers. It does not understand what it carries. A request goes to the agent under a
rewritten id and the answer goes back to the browser that asked; events from the agent fan out to
every browser; terminal output goes only to the browsers subscribed to that terminal. Because it
forwards any method name untouched, new features on the Mac need no change here. The one thing it
reads is a notification, which it sends on to your devices as a push message.

The **client** is the web app, built to be added to an iPhone home screen. It logs in with an email
and password, holds one WebSocket to the relay, and redraws when the Mac says the workspace changed.

```
Hako on the Mac ──wss, dials out──▶ relay ◀──https + wss── browser
   (agent)                      (this repo)                (client)
```

## The terminal

Tapping a tab opens its terminal, drawn with [xterm.js](https://xtermjs.org) in the colours and font
of the Hako on your Mac. `#/t/<session id>` is its address, so a link can open one directly.

- **Size.** By default the phone does not resize anything: you see the terminal at the size it has
  on your Mac, scaled so its full width fits, and you pinch to zoom and drag to pan. **Fit to
  phone** (under the size shown in the title bar, or under "more" in the key bar) resizes the
  terminal on the Mac to the phone's screen instead, and gives the size back when you turn it off or
  leave. It only ever makes the terminal smaller: in a browser window that holds more than the
  Mac's pane, where the switch is called **Shrink to this window**, the terminal keeps the size it
  has on the Mac. The choice is remembered.
- **Keys.** A bar above the keyboard has Esc, Tab, Shift+Tab, a sticky Ctrl (tap it for the next
  key, hold it to lock), Ctrl+C, the arrows (which repeat while held), Enter, Paste, and a key that
  hides the keyboard. "More" holds Alt, Ctrl+D, Ctrl+L, Ctrl+R, Ctrl+Z, Home, End, Page up, Page
  down, Delete and the symbols that take three taps on a phone keyboard.
- **Message box.** One tap switches between typing straight into the terminal, with autocorrect
  off, and a message box with autocorrect and dictation on. "Send" writes the message and presses
  Enter; "Insert" writes it without. This is the comfortable way to write a prompt for Claude Code.
- **Scrolling and copying.** One finger scrolls the history, and in a full-screen program sends
  arrow keys. Holding a finger on the terminal, or "Select text" under "more", shows the history and
  the screen as plain text that selects and copies like any other.
- **Moving around.** Tapping the title lists every terminal on the Mac; swiping the title bar steps
  to the next or the previous one. A tab with several terminals shows them as a row to choose from.
- **When the link breaks.** If the Mac goes offline or the connection drops, the last screen stays
  under a banner and comes back by itself.

With a hardware keyboard and a mouse (a desktop browser, an iPad) the terminal takes keys,
selection, copy and paste directly, and the key bar is still there. On a Mac keyboard Option types
the characters of your layout, as in any Mac app; for Alt as a terminal modifier use Esc as a
prefix, or the sticky Alt under "more".

## Files

**Files** starts from the directories of your folders and of your terminals, and from your home
directory, and drills down from there. The folder button in a terminal's title bar opens that
terminal's working directory.

- **Browsing.** One directory at a time, directories first, with a path to tap your way back up, a
  filter for the directory you are in, and a switch for hidden files. Each starting point remembers
  where you left it. A directory with thousands of entries scrolls like a short one.
- **Reading.** Text opens with syntax colours, line numbers, a soft-wrap switch and find. Markdown
  opens as source, with a switch to the rendered document; raw HTML in it is shown as text, never
  run. Pictures (PNG, JPEG, GIF, WebP, SVG) open as pictures, and two fingers zoom into them. Text
  over 2 MB, pictures over 5 MB and binary files are named for what they are, with their size.
- **Editing.** Edit turns the view into an editor, with a bar of Tab, undo, redo and the symbols a
  phone keyboard buries. Save writes the file back. If the file changed on your Mac in the
  meantime, nothing is written and you choose: reload the Mac's version, or overwrite it with
  yours. Leaving with unsaved changes asks first.
- Creating, renaming, moving and deleting stay on the Mac.

A Hako that does not have the file methods yet answers `not_supported`, and Files says to update
it.

## Source control

**Source control** lists every git repository and worktree in the directories of your folders,
repositories nested in others included: those with changes first, then those with something to
push or pull, then the rest, with a filter over all of them. Each shows its branch (or the commit a
detached HEAD is at), how many commits it is ahead and behind, and how many files changed.

- **One repository.** Its changed files with what happened to each (modified, added, deleted,
  renamed, untracked, in conflict) and the lines that went in and out. Commit, Push and Pull sit at
  the bottom of the screen and on the repository's row in the list.
- **A diff.** Tapping a file shows it against the last commit: line numbers, `+` and `−` beside
  the colours, the changed part of a changed line marked, and a switch between wrapped lines and
  lines that run on sideways. From there you step to the next changed file, open the file in Files,
  or discard its changes. A binary file, and a diff over 1 MB, are named for what they are.
- **Committing.** A commit takes every changed file in the repository, as the button on the Mac
  does; there is no choosing among them. The message is written in a sheet that stays above the
  keyboard, and the commit can be pushed straight after.
- **Push and pull.** A branch that is not on a remote yet is published by its first push. Whatever
  git prints is shown, with a line on what it means when a push was rejected, a pull stopped at
  conflicts, or your Mac could not sign in. Nothing is tried a second time by itself.
- **Discarding.** One file's changes, or all of them, after a question that says what will be lost,
  untracked files included. It cannot be undone.

The list is read again when you open it, when you ask, after everything you do, and when the page
comes back to the foreground. A Hako that does not have these methods yet answers `not_supported`,
and Source control says to update it.

## Notifications on iPhone

Hako on your Mac can tell your phone when a coding agent such as Claude Code is waiting for you (a
permission request, a question), when it has finished, and when a long command has finished.
Tapping the notification opens that terminal. They are sent whether or not you are at the Mac.

- **What it needs.** iOS 16.4 or later, and Hako **added to the home screen**: in Safari, Share,
  then "Add to Home Screen", then open Hako from the new icon. A site in a Safari tab cannot send
  notifications on an iPhone. A current Chrome, Edge, Firefox or Safari on a computer works too.
- **Where to turn it on.** Account, then Notifications, then "Turn on notifications", and Allow
  when the phone asks. The same place says what is in the way when something is (not on the home
  screen yet, turned off in the Settings app), has a Mute switch and a switch for each of the three
  kinds, and sends a test notification. The switches belong to the device.
- **In the app.** While Hako is open, a notification also shows as a banner over the app.
- **What leaves your server.** A notification's title and text, such as "Claude Code needs your
  permission" and "Allow Bash: pnpm test?", travel from the relay through the push service of the
  phone's maker (Apple's, for an iPhone) to the phone. They are encrypted for that device, so the
  push service cannot read them, but it does see that your relay sent your phone something, when,
  and how large. Mute, or logging out on the phone, stops it.

The relay makes the key it signs these messages with on its first start and keeps it in its
database; nothing has to be configured. A Hako that does not send notifications yet simply sends
none.

## Run it locally

You need Node 24 and pnpm, and Python 3 for the mock agent's shell. A mock agent stands in for the
desktop app, with two windows of sample folders and tabs, fake terminals that print a line every
second, one real shell, a throwaway tree of sample files, and git repositories in it. It needs
`git` on the path.

```sh
pnpm install
cp .env.example .env        # then edit the values
pnpm build                  # builds the web app into dist/
pnpm start                  # relay and web app on http://localhost:8787
pnpm mock-agent             # in a second terminal
```

Open http://localhost:8787 and log in with `HAKO_OWNER_EMAIL` and `HAKO_INITIAL_PASSWORD`. Stop the
mock agent and the page shows the Mac as offline; start it and the workspace comes back.

For work on the web app, run `pnpm dev:server` and `pnpm dev` instead and open
http://localhost:5173. Vite proxies `/api` and `/ws` to the relay.

`pnpm test` runs the unit tests and `pnpm typecheck` checks both the server and the client.

### The mock agent's real shell

**The tab called "real shell", and every tab you open while the mock agent runs, is a real shell on
your computer.** Whoever can log in to the relay the mock agent is connected to can run commands in
it as you. So:

- Run the mock agent only while you are testing, and only against a relay you are testing. Stop it
  when you are done; never leave it running.
- Against a relay on `localhost` the shell is on by default. Against any other relay it is off
  unless you start the mock agent with `MOCK_SHELL=1`. `MOCK_SHELL=0` turns it off everywhere.
- The shell is `zsh` (or `sh`) started by `scripts/pty-helper.py`, a small Python helper that gives
  it a pseudo-terminal without a native Node module. It starts in the mock agent's temporary
  directory, or in `MOCK_SHELL_DIR`, with that directory as its home and a clean environment, so it
  sees neither your dotfiles nor the secrets in `.env`. It can still reach everything your user can.

### The mock agent's files

At start the mock agent builds a tree of sample files in a new temporary directory and removes it
when it stops. The sample workspace lives in that tree, and so does the real shell, so its folders
can be browsed and what the shell changes shows up. The file methods serve that tree and refuse
every path outside it. It holds a file of each highlighted language, a Markdown file with things
that must stay inert, pictures, a text file and a picture over the limits, a binary file, a
directory with 5,000 entries, a read-only file, a directory that may not be read, and symlinks that
work, dangle and point outside.

- `kill -USR2 <pid of the mock agent>` rewrites `fixtures/conflict.txt`, which is how to see a
  save being refused because the file changed.
- `MOCK_FS=0` leaves the file methods out, as a desktop app from before they existed would.
- `MOCK_FS_DELAY_MS=1500` makes every file answer slow.

### The mock agent's repositories

The folders of that tree are git repositories, built at start by the real `git` command line and
removed with the tree. The source control methods run git in them and in nothing else, with a
name and an email set in each repository and without reading your own git configuration.

| Repository              | What it is for                                                                                                                                                    |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `hako`                  | One change of every kind: modified, added, deleted, renamed, untracked, binary, a line far too long, a missing final newline. No remote.                          |
| `hako/vendor/glyphs`    | A repository inside another one, on a detached HEAD.                                                                                                              |
| `hako-remote`           | A diff of thousands of lines, and one over the 1 MB limit.                                                                                                        |
| `Notes`                 | Nothing to commit.                                                                                                                                                |
| `egehakan.com`          | A local bare repository as its remote. It starts one commit ahead and one behind, with the two in conflict: a push is rejected, and a pull stops at the conflict. |
| `egehakan.com-redesign` | A linked worktree of it, on a branch that was never pushed, so its first push publishes the branch.                                                               |

The mock agent prints the path of a script, `teammate-pushes.sh`, that pushes one more commit to
that remote as someone else would. After it a push is rejected until you pull, and a pull is
refused while `style.css` has changes that are not committed.

- `MOCK_GIT=0` leaves the source control methods out, as a desktop app from before they existed
  would.
- `MOCK_GIT_EMPTY=1` answers that there are no repositories.
- `MOCK_GIT_DELAY_MS=1500` makes every answer slow, and `MOCK_GIT_NETWORK_DELAY_MS=25000` makes a
  push or a pull take longer than the relay waits for an ordinary request.

### The mock agent's notifications

The mock agent sends a `notify` event when asked. In the terminal it runs in, press `w` (an agent
is waiting), `d` (an agent has finished), `c` (a long command has finished) or `b` (four within a
second, which the relay collapses into two). From anywhere else, write `agent_waiting`,
`agent_done`, `command_done` or `burst` to the file it names when it starts (`MOCK_NOTIFY_FILE`
chooses it), with a session id after the word to pick the terminal. An agent's notification also
changes the status that terminal shows in the workspace list.

A real notification needs the browser's permission. To see each state of Account, Notifications
without it, on the development server only, run `localStorage.setItem("hako.notify.force",
"<state>")` in the console and reload. The states are `unsupported`, `ios-update`,
`needs-home-screen`, `ask`, `denied`, `denied-ios`, `connecting`, `failed`, `enabled` and
`enabled-test-fails`; removing the entry switches back.

Two more things help when working on the terminal:

- `kill -USR1 <pid of the mock agent>` drops the next output frame of every terminal that is being
  watched, which shows how the client recovers from lost output.
- A desktop browser gets the mouse-and-keyboard input path. To try the phone's path there (the
  hidden text field, touch scrolling, the keyboard key), run `localStorage.setItem("hako.touch",
"1")` in the console and reload; `"0"`, or removing the entry, switches back.

## Configuration

| Variable                | Meaning                                                                                                                                                                                                                                             |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `HAKO_OWNER_EMAIL`      | The email of the one account. There is no sign-up.                                                                                                                                                                                                  |
| `HAKO_INITIAL_PASSWORD` | Used once, to create the account when the database is empty. Changing it later does nothing; change the password in the app.                                                                                                                        |
| `HAKO_AGENT_KEY`        | The key the desktop app sends as `Authorization: Bearer …` on `/ws/agent`. At least 24 characters.                                                                                                                                                  |
| `HAKO_SESSION_SECRET`   | Signs session cookies. At least 24 characters. Changing it logs every device out.                                                                                                                                                                   |
| `PUBLIC_ORIGIN`         | The origin the app is served from, such as `https://hako.example.com`. Requests and WebSockets from any other origin are refused. Several origins can be given, separated by commas. Cookies are marked `Secure` when every origin is HTTPS.        |
| `DATA_DIR`              | Where `hako.db` lives. Defaults to `./.data`.                                                                                                                                                                                                       |
| `PORT`                  | Defaults to `8787`.                                                                                                                                                                                                                                 |
| `VAPID_PUBLIC_KEY`      | Optional, with `VAPID_PRIVATE_KEY`: the key pair notifications are signed with, in base64url, in place of the pair the relay makes and keeps in its database. Changing it makes every device subscribe again the next time the app is opened there. |
| `VAPID_PRIVATE_KEY`     | See above. Both or neither.                                                                                                                                                                                                                         |
| `VAPID_SUBJECT`         | Optional. The contact the relay names to push services, a `mailto:` or an `https:` address. Defaults to `mailto:` and `HAKO_OWNER_EMAIL`.                                                                                                           |

Generate the two secrets with something like `openssl rand -base64 36`.

## Deploy to Railway

Railway builds the `Dockerfile` in this repository.

1. Create a service in a Railway project and attach a volume mounted at `/data`.
2. Set the variables above on the service, with `DATA_DIR=/data`, `PORT=8787` and `PUBLIC_ORIGIN`
   set to the public URL you will use.
3. In the service settings, set the health check path to `/api/health`.
4. Deploy, either with `railway up` from this folder or by connecting the GitHub repository.
5. Add your domain to the service, on port 8787, and create the DNS records Railway asks for.

Run exactly one replica: the relay holds the agent connection and the SQLite file in one process.

Then point the desktop app at `wss://<your domain>/ws/agent` with the same `HAKO_AGENT_KEY`.

## Security

Be clear about what this is: **it puts a shell on your computer on the public internet, behind one
password.** Anyone who has that password, or a logged-in session, can do what you can do in a
terminal on your Mac, can read and rewrite any file you can, and can commit, push and throw away
changes in your repositories. Anyone who has the agent key can pose as your Mac to the relay.

What stands in the way:

- One account, no sign-up, and a password stored as a salted scrypt hash.
- Five wrong passwords for an email block further tries for 15 minutes.
- Sessions are random ids in an HttpOnly, Secure, SameSite=Lax cookie, valid 30 days, stored hashed.
  Changing the password ends every other session.
- `/ws/client` needs a valid session and an `Origin` header equal to `PUBLIC_ORIGIN`; `/ws/agent`
  needs the agent key, compared in constant time.

The mock agent is a development tool with a real shell behind it (see above). Do not connect it
to a relay that is reachable from the internet for longer than a test takes.

What does not:

- **Data is protected by TLS only.** There is no end-to-end encryption between the browser and the
  Mac. The relay, and whoever runs or compromises the machine it is on, can read and change
  everything that passes through, including what you type into a terminal.
- There is no second factor.
- **Notifications pass through a third party.** With notifications on, their titles and texts go
  from the relay to the phone through the push service of the phone's maker: Apple's for an
  iPhone, Google's or Mozilla's for other browsers. They are encrypted for the device on the way,
  so the push service cannot read them; it learns that your relay sent your device a message, when
  and how large, and it is given `HAKO_OWNER_EMAIL` as the relay's contact. A notification can also
  be read on a locked phone. The relay stores, for each device, the address and the keys the
  browser gave it for this, until that device logs out.
- A stolen, unlocked phone with the app open is a terminal on your Mac.

So use a long password that you use nowhere else, keep the agent key and the session secret out of
the repository, and host the relay somewhere you trust. If you do not need remote access for a
while, quit Hako on the Mac or stop the relay.

## Licence

[MIT](LICENSE). The folder icons in `public/folder-icons` come from Material Icon Theme and carry
their own [MIT licence](public/folder-icons/LICENSE).
