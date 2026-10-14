# Hako Remote

A phone-first web app, and the relay server behind it, for seeing and controlling the
[Hako](https://github.com/egehakan/hako) terminal on your Mac from a browser: which folders and tabs
are open, what each terminal is running, and whether a coding agent in one of them is working,
waiting for you or done. You can open a terminal in a folder, bring a tab to the front, rename it
(its ⋯ menu) and close it, rename a folder, and add a folder for any directory on the Mac ("New
folder" on the Terminals screen picks the directory, and can make a new one first). You can use any
of those terminals live: a shell, or a full-screen program such as Claude Code, with the keys a
phone keyboard lacks. You can also browse the folders of your projects, read a file with syntax
colours, make a small edit and save it, save any file to your phone and put files from your phone
into a folder on the Mac; you can hand Claude Code a picture from your phone in a terminal; and you
can see what changed in every repository in those folders, read the diffs, commit, push and pull,
and merge one branch into another. You can try the web app Claude Code just changed, served by its
dev server on the Mac, inside this app at the size of any phone, tablet or computer. And your phone
is told when an agent is waiting for you or has finished, when a long command is done, and when a
preview is ready.

Hako Remote is a companion to [Hako](https://github.com/egehakan/hako), a personal terminal that is
based on Warp. Neither project is affiliated with, or endorsed by, Warp.

## How it works

There are three parties, and the contract between them is [docs/protocol.md](docs/protocol.md).

The **agent** is the Hako desktop app. It never listens on the network. It dials out to the relay
over a WebSocket, proves itself with a shared key, and then answers requests: list the workspace,
create a tab, close a tab, attach to a terminal, list a directory, read and write a file, move a
file in pieces, run git in a repository.

The **relay** is the server in this repository, a single Node process. It serves the web app, keeps
the one account and its login sessions in SQLite, and passes messages between the agent and any
number of browsers. It does not understand what it carries. A request goes to the agent under a
rewritten id and the answer goes back to the browser that asked; events from the agent fan out to
every browser; terminal output goes only to the browsers subscribed to that terminal. Because it
forwards any method name untouched, new features on the Mac need no change here. The one thing it
reads is a notification, which it sends on to your devices as a push message. It also serves each
preview on an address of its own and carries its HTTP and WebSockets to the dev server on the Mac
over the same connection.

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
- **Scrolling and copying.** One finger scrolls the history. A full-screen program gets the mouse
  wheel if it reads the mouse, as Claude Code does, and arrow keys if it does not. Holding a finger
  on the terminal, or "Select text" under "more", shows the history and the screen as plain text
  that selects and copies like any other.
- **Attaching a picture.** The picture key on the key bar, or the same button beside the message
  box, offers the phone's photo library, camera and files. Each picture goes to your Mac and its
  path is typed where you are writing, as if you had dragged the picture into the terminal, with a
  space after it and without Enter; Claude Code takes such a path as an attached image. Several in
  a row work, each with a small progress chip, and if one does not arrive nothing is typed. A
  picture Claude Code cannot take (an iPhone's HEIC) is turned into a JPEG first, and one larger
  than 2,576 pixels on its longer side is scaled down to that; any other picture is sent as it is.
  **On the Mac attached pictures are kept in `~/.hako/uploads/<date>/` and deleted after 7 days**,
  not in your project.
- **Tapping a path.** A path in the output opens in Files: a directory as its list, a file in the
  viewer, scrolled to the line when a `:line` or `:line:column` follows it. That holds for absolute
  paths, `~/` paths, paths relative to the terminal's directory, quoted ones with spaces in them,
  links a program printed as OSC 8 hyperlinks, and the paths in Claude Code's tool lines
  (`Read(src/app.ts)`, `src/app.ts:12:5`). A long path that a program broke onto several rows
  itself, indented or inside a box, opens from a tap on any of its rows. The Mac is asked first
  whether something is there, and the path is underlined while it answers; a path that is not there
  does nothing, and the next tap on it raises the keyboard. The line being typed on is left to the
  keyboard. With a mouse, paths underline under the pointer and open with a click.
- **Programs that take the mouse.** While a program reads the mouse, as Claude Code's full-screen
  mode does, a tap is a click at that spot (so a tap opens a subagent to see what it is doing), and
  it does not raise the keyboard; the keyboard key on the key bar does. A tap on a path still opens
  the path. Dragging still scrolls, and holding still selects text. Taps land on the right cell at
  any zoom, fitted to the phone or not.
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
- **Saving to your phone.** "Save to phone", in a file's menu (the dots at the end of its row) or
  at the top of an open file, fetches it with a progress bar and hands it over. On an iPhone that
  is the share sheet, which is the dependable way from a home-screen app to "Save Image" into
  Photos or "Save to Files"; a computer's browser downloads it. Any file up to the limit the Mac
  states (200 MB with a current Hako); one over 50 MB first shows its size and waits for a yes,
  since the phone holds it in memory until it is saved. If it changes on the Mac while it is being
  read, you are told and can try again.
- **Folders as a zip.** "Download as .zip" in a folder's menu (and in the menu of the folder you
  are in, the dots at the top) has the Mac zip it and then fetches the zip. A switch, on by
  default, leaves out what can be made again: `.git`, `node_modules`, virtual environments,
  `__pycache__`, `.next`, `.turbo`, `.gradle`, `Pods`, `DerivedData` and a Rust `target`; how many
  folders were left out is said when the zip is ready.
- **Uploading.** "Upload" at the bottom of a folder opens the phone's own choice of photo library,
  camera and files, several at a time, and puts them in that folder exactly as they are, up to the
  same limit each. Each has its progress and can be cancelled. A name that is already there is
  never overwritten without asking: replace it, keep both (the new one becomes `name (2).ext`), or
  cancel. A file only appears under its name on the Mac once it has arrived whole.
- **Uploading a folder.** In a computer's browser, "Upload", then "A folder", makes the folder's
  directories on the Mac and sends its files into them (empty directories are not part of what a
  browser hands over). Safari on an iPhone can't pick a folder, so there the sheet offers a .zip
  instead (the Files app makes one with Compress); when it has arrived, "Extract here" on it, or in
  a zip's menu, unpacks it into a new folder beside it. A zip that holds one folder unpacks as
  that folder. A zip whose entries would land outside its folder, a zip with a password and one
  that unpacks to over 1 GB or 50,000 entries are refused.
- **Changing files.** Hold a row (or "Select" in a row's menu, or the dots at the top) to choose
  several; a bar at the bottom then has Copy, Cut, Duplicate, Rename, Trash and More. Each row's
  menu has the same for one item, and "New" at the bottom makes a folder or an empty file. Copy and
  Cut fill the app's own clipboard, which a small bar shows with "Paste here" in whatever folder
  you are in, until it is pasted or cleared. When names are already there, one question covers the
  whole paste: keep both, replace (a file only, never a folder), or skip those. Move to Trash asks
  first, naming what goes, and uses the Mac's Trash, where "Put Back" works; nothing is deleted
  for good from here. Long copies, moves and zips show that they are under way, and when some
  items fail each is listed with what the Mac said. With a keyboard: Cmd or Ctrl and C, X, V, A;
  Delete or Backspace for the Trash; F2 to rename; Cmd- or Ctrl-click and Shift-click to choose;
  a right click opens a row's menu.
- **Copying a path.** "Copy path" and "Copy relative path" are in each row's menu, above the bar
  when one item is selected, and in an open file's menu (the dots at the top). The relative path is
  the one from the deepest folder or terminal directory that holds it, else from home, and `.` for
  that folder itself; outside all of them it is `~/…` or the full path. "Copied" says what went on
  the phone's clipboard; a browser that refuses shows the path to select and copy by hand.
- **Previews.** PDFs (every page, drawn as they come into view, with two-finger zoom and a page
  counter), Word `.docx` documents (as text, headings, lists, tables and pictures, with nothing
  that runs and nothing fetched from elsewhere), spreadsheets (`.xlsx`, `.xls`, `.ods`, `.csv`,
  `.tsv`, a table per sheet, the first 2,000 rows of each) and PowerPoint `.pptx` (each slide's
  text and pictures in order; the layout is not kept) open as previews. The file is fetched whole
  first, so the size limit for saving applies. A CSV or TSV small enough to open as text has a
  switch between its text and its table.
- **When the link breaks.** A transfer pauses while the Mac is out of reach (or the phone puts the
  app in the background) and goes on by itself when it is back. If Hako on the Mac was restarted
  in the meantime, the transfer fails with a button to try again.

A Hako that does not have the file methods yet answers `not_supported`, and Files says to update
it; the same goes for saving, uploading and attaching pictures, which need a newer Hako again, and
for changing files, zipping and unzipping, which need a newer one still.

## Source control

**Source control** lists every git repository and worktree in the directories of your folders,
repositories nested in others included: those with changes first, then those with something to
push or pull, then the rest, with a filter over all of them. Each shows its branch (or the commit a
detached HEAD is at), how many commits it is ahead and behind, and how many files changed.

- **One repository.** Its changed files with what happened to each (modified, added, deleted,
  renamed, untracked, in conflict) and the lines that went in and out, and under them its graph.
  Each of the two folds away. Commit, Push and Pull sit at the bottom of the screen and on the
  repository's row in the list.
- **Branches.** The branch's name, on a repository's row and at the top of its screen, opens the
  list of branches: those on your Mac, then those only on the remote, with a filter and "New
  branch", which starts one at the commit you are on. Choosing one switches to it. Nothing is
  stashed, forced or thrown away for it: when git refuses, because your changes are in the way or
  the branch is open in another worktree, what git said is shown and nothing has changed.
- **The graph.** The history of the current branch as the editor on your desk draws it: its line in
  amber, its upstream's beside it in blue where the two differ, what was merged in in grey, with
  the branches and tags that point at each commit. A commit that is not pushed yet, or not pulled
  yet, is a ring with an arrow at the end of its row, and a line above the list says how many
  there are of each, with Push and Pull. Older commits load as you reach them.
- **A commit.** Tapping one shows its message, author, date and hash, and the files it changed;
  tapping a file shows what that commit changed in it.
- **A diff.** Tapping a file shows it against the last commit: line numbers, `+` and `−` beside
  the colours, the changed part of a changed line marked, and a switch between wrapped lines and
  lines that run on sideways. From there you step to the next changed file, open the file in Files,
  or discard its changes. A binary file, and a diff over 1 MB, are named for what they are.
- **Merging.** In the list of branches each branch other than the current one has Merge, which
  merges it into the current branch after a question that names both. Git fast-forwards when it
  can; the result is said in a line ("Fast-forwarded", "Merged", "Already up to date"). When the two
  sides changed the same lines, git stops at the conflicts and the repository shows a banner,
  "Merging <branch>: N conflicts", with each file in conflict (tapping one opens it in Files to
  edit), Abort merge, and Commit merge with git's message filled in. Your Mac refuses to commit
  while a file in conflict still holds conflict markers, and the files it names open from there.
- **Committing.** A commit takes every changed file in the repository, as the button on the Mac
  does; there is no choosing among them. The message is written in a sheet that stays above the
  keyboard, and the commit can be pushed straight after.
- **Push and pull.** A branch that is not on a remote yet is published by its first push. Whatever
  git prints is shown, with a line on what it means when a push was rejected, a pull stopped at
  conflicts, or your Mac could not sign in. Nothing is tried a second time by itself.
- **Discarding.** One file's changes, or all of them, after a question that says what will be lost,
  untracked files included. It cannot be undone.

The list is read again when you open it, when you ask, after everything you do, and when the page
comes back to the foreground, and so are the branches and the graph. A Hako that does not have
these methods yet answers `not_supported`, and Source control says to update it; one that has them
but not branches and the graph yet says so in their place, and the rest works as before.

## Previews

When Claude Code on the Mac starts the app it changed (the `preview` skill does this in a Hako
tab), the app appears under **Previews**: its name, its folder, its ports and whether it runs, with
Stop, Restart, Remove and "Show logs", which opens the tab its dev server prints to. Open shows it
in this browser ("Phone browser"), served by the dev server on the Mac:

- **A browser's controls.** Back, forward, reload, and the address, which you can tap to go to
  another path. The triangle counts the errors and warnings the page logged, and opens them.
- **Viewport.** Fit fills the screen. A phone (iPhone SE, iPhone 15/16, iPhone 16 Pro Max, Pixel 8),
  a tablet (iPad mini, iPad Air), a computer (1280×800, 1440×900, 1920×1080) or a size of your own
  shows the page exactly as wide as that device, scaled down to fit; rotate swaps the sides, zoom
  enlarges it, and the hand lets you drag it around. The choice is remembered for each preview.
- **Open on its own** opens the preview in a tab of its own (a Safari page from the home-screen
  app).
- **Like on the Mac.** Each preview has its own address, `https://<name>.<your domain>`, and each
  other port of it its own, `https://<name>--<port>.<your domain>`. The dev server sees requests
  addressed to `localhost`, so a frontend on one port that calls its API on another by
  `http://localhost:<port>` works unchanged: the relay and a small script it puts into every page
  translate those addresses both ways. Hot reload works, and so do WebSockets, server-sent events,
  cookies, redirects and downloads.
- **Only for you.** A preview opens only from the app: the app asks the relay for a one-time link,
  which gives this browser a preview cookie for 12 hours, bound to your login. Anyone else gets
  "Open this preview from Hako".

The relay needs a wildcard DNS name and certificate for this: `*.<your domain>` pointing at the
same service as `<your domain>` (see [Deploy](#deploy-to-railway)). A Hako without previews shows
"update Hako on your Mac".

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

To try previews in the app's frame, give the relay a name under `localhost` with
`PUBLIC_ORIGIN=http://hako.localhost:8787` and open http://hako.localhost:8787: previews are then at
`http://<name>.hako.localhost:8787`, which browsers resolve without DNS. (With plain `localhost`,
Chrome counts `<name>.localhost` as another site, so the app's frame would not carry the preview
cookie.)

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
- In it, `show-paths` prints paths of every kind to tap, `show-wrapped` prints long paths broken
  onto several rows at the terminal's width, as Claude Code and git break them, and `mouse-test`
  (`scripts/mouse-test.py`) is a full-screen program that reads the mouse and says where each press
  and release landed, with a list of "agents" that open and close on a tap; `--legacy` and `--x10`
  try the older mouse reports. `q` leaves it.
- `MOCK_RENAME=0` leaves out renaming tabs and folders, as a desktop app from before it would.
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
- `Downloads` holds what moving files is tried with: files of several pieces, one at the 200 MB limit
  and one just over it, `notes.txt` to upload another of, and a folder that may not be written to.
  `kill -USR2 <pid>` also rewrites `Downloads/changes-while-read.bin`, to see a download refused
  because the file changed. Attached pictures go to a temporary uploads area of the mock agent's
  own, which it names at start and removes when it stops.
- `MOCK_TRANSFERS=0` leaves out only the transfer methods, as the desktop app before them would;
  `MOCK_UPLOAD_IDLE_MS` shortens the 15 minutes an untouched upload is kept.
- `MOCK_FS_DELAY_MS=1500` makes every file answer slow.
- Renaming, copying, moving, the Trash, zipping and unzipping change the tree for real. The Trash
  is a `.Trash` directory at the top of the tree, and zips for downloading go to `.hako/archives`
  there. `Documents/Previews` holds a document of each kind the previews read (a 20-page PDF, a
  Word file, spreadsheets with two sheets, CSV and TSV files, one over 2 MB, slides), made at
  start. `Downloads/zips` holds zips that unpack and zips that must be refused (an entry that
  escapes its folder, a link that points out of it, a password, a file that is not a zip), and
  `Downloads/project-with-heavy-folders` shows what "leave out heavy folders" leaves out.
  `MOCK_OPS=0` leaves these methods out, as a desktop app from before them would, and
  `MOCK_OPS_DELAY_MS=4000` makes them slow.
- `MOCK_FOLDERS=0` leaves out adding a folder and making a directory, as a desktop app from before
  them would, and "New folder" then says to update Hako.

### The mock agent's repositories

The folders of that tree are git repositories, built at start by the real `git` command line and
removed with the tree. The source control methods run git in them and in nothing else, with a
name and an email set in each repository and without reading your own git configuration.

| Repository                    | What it is for                                                                                                                                                                                                                                                                                                                                                                |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `hako`                        | One change of every kind: modified, added, deleted, renamed, untracked, binary, a line far too long, a missing final newline. No remote. Git refuses to switch it to `protocol-v2`, which the changes are in the way of, and switches it to `spike/key-bar`.                                                                                                                  |
| `hako/vendor/glyphs`          | A repository inside another one, on a detached HEAD.                                                                                                                                                                                                                                                                                                                          |
| `hako-remote`                 | A diff of thousands of lines, and one over the 1 MB limit.                                                                                                                                                                                                                                                                                                                    |
| `hako-remote/fixtures/sketch` | A repository without a commit.                                                                                                                                                                                                                                                                                                                                                |
| `Notes`                       | Nothing to commit, and 2,400 commits to page through, with a side line merged in now and then.                                                                                                                                                                                                                                                                                |
| `egehakan.com`                | A local bare repository as its remote. It starts two commits ahead and one behind, with the two sides in conflict: a push is rejected, and a pull stops at the conflict. Its history has a merge, a tag and a rename, and it has branches of every kind: one ahead of its remote, one that was never pushed, one that is only on the remote, and one that the worktree holds. |
| `egehakan.com-redesign`       | A linked worktree of it, on a branch that was never pushed, so its first push publishes the branch.                                                                                                                                                                                                                                                                           |

The mock agent prints the path of a script, `teammate-pushes.sh`, that pushes one more commit to
that remote as someone else would. After it a push is rejected until you pull, and a pull is
refused while `style.css` has changes that are not committed.

- `egehakan.com` also has `copy/title`, which conflicts with `main` when merged into it, and
  `docs/readme`, which `main` fast-forwards to; `feature/dark-mode` merges with a merge commit and
  `release/1.0` is already merged.
- `MOCK_GIT=0` leaves the source control methods out, as a desktop app from before they existed
  would. `MOCK_GIT_HISTORY=0` leaves out only branches, switching and the graph, and
  `MOCK_GIT_MERGE=0` only merging.
- `MOCK_GIT_EMPTY=1` answers that there are no repositories.
- `MOCK_GIT_DELAY_MS=1500` makes every answer slow, and `MOCK_GIT_NETWORK_DELAY_MS=25000` makes a
  push or a pull take longer than the relay waits for an ordinary request.
  `MOCK_GIT_SWITCH_DELAY_MS=65000` makes a switch of branch outlast the minute the app waits for
  one, after which it says that the switch is still going on and reads the repository when it ends.

### The mock agent's previews

The mock agent runs real dev servers as previews, each in a tab of its own that shows what it
prints (Ctrl+C there stops it), and stops them when it stops. Two are always there: "Demo site",
which tries a WebSocket, server-sent events, a redirect to its own `localhost` address, a cookie for
`Domain=localhost`, a page that refuses to be framed and logs an error, its request headers and a
large download (`/big?mb=50`), and "Web and API", a page on one port that calls its API on another
by `http://localhost:<port>`, with credentials, an image and a WebSocket. To add your own, such as
a Vite or Next.js app, list them in a JSON file and name it in `MOCK_PREVIEWS`:

```json
[
  {
    "id": "vite",
    "name": "Vite app",
    "directory": "/path/to/app",
    "command": "./node_modules/.bin/vite --port {port} --strictPort",
    "port": 5199
  }
]
```

`ports` (`[{ "port", "label" }]`) adds more ports, `url_path` the path to open first.
`MOCK_PREVIEWS_OFF=1` leaves previews out, as a Hako without them would.

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
| `PREVIEW_DOMAIN`        | Optional. The domain previews are served under, as `<name>.<domain>`. Defaults to the host of the first `PUBLIC_ORIGIN`, and must be that host or a domain under it; an IP address there means no previews.                                         |
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
5. Add your domain to the service, on port 8787, and create the DNS records Railway asks for. For
   previews, add the wildcard `*.<your domain>` the same way; Railway issues a certificate for it.

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
- Previews are served on origins of their own, never on the app's, so a page under development
  cannot reach the app's API or read its cookie: the session cookie is `__Host-` and host-only,
  and a request from a preview to `/api` fails the `Origin` check. A preview opens only with a
  one-time ticket from a logged-in app, which buys a signed preview cookie bound to that login;
  logging out ends it. Only the app may frame a preview.

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
- **A preview is a dev server on your Mac, reachable from the internet** by whoever holds your
  login. Like localhost on the Mac, all previews share one cookie domain, so one preview's pages
  can set cookies the others receive.

So use a long password that you use nowhere else, keep the agent key and the session secret out of
the repository, and host the relay somewhere you trust. If you do not need remote access for a
while, quit Hako on the Mac or stop the relay.

## Licence

[MIT](LICENSE). The folder icons in `public/folder-icons` come from Material Icon Theme and carry
their own [MIT licence](public/folder-icons/LICENSE).
