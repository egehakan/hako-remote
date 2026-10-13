# Hako Remote

A phone-first web app, and the relay server behind it, for seeing and controlling the
[Hako](https://github.com/egehakan/hako) terminal on your Mac from a browser: which folders and tabs
are open, what each terminal is running, and whether a coding agent in one of them is working,
waiting for you or done. You can open a terminal in a folder, bring a tab to the front and close one.
The live terminal itself is the next step; the relay already routes its output.

Hako Remote is a companion to [Hako](https://github.com/egehakan/hako), a personal terminal that is
based on Warp. Neither project is affiliated with, or endorsed by, Warp.

## How it works

There are three parties, and the contract between them is [docs/protocol.md](docs/protocol.md).

The **agent** is the Hako desktop app. It never listens on the network. It dials out to the relay
over a WebSocket, proves itself with a shared key, and then answers requests: list the workspace,
create a tab, close a tab, attach to a terminal.

The **relay** is the server in this repository, a single Node process. It serves the web app, keeps
the one account and its login sessions in SQLite, and passes messages between the agent and any
number of browsers. It does not understand what it carries. A request goes to the agent under a
rewritten id and the answer goes back to the browser that asked; events from the agent fan out to
every browser; terminal output goes only to the browsers subscribed to that terminal. Because it
forwards any method name untouched, new features on the Mac need no change here.

The **client** is the web app, built to be added to an iPhone home screen. It logs in with an email
and password, holds one WebSocket to the relay, and redraws when the Mac says the workspace changed.

```
Hako on the Mac ──wss, dials out──▶ relay ◀──https + wss── browser
   (agent)                      (this repo)                (client)
```

## Run it locally

You need Node 24 and pnpm. A mock agent stands in for the desktop app, with two windows of sample
folders and tabs and fake terminals that print a line every second.

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

## Configuration

| Variable | Meaning |
|---|---|
| `HAKO_OWNER_EMAIL` | The email of the one account. There is no sign-up. |
| `HAKO_INITIAL_PASSWORD` | Used once, to create the account when the database is empty. Changing it later does nothing; change the password in the app. |
| `HAKO_AGENT_KEY` | The key the desktop app sends as `Authorization: Bearer …` on `/ws/agent`. At least 24 characters. |
| `HAKO_SESSION_SECRET` | Signs session cookies. At least 24 characters. Changing it logs every device out. |
| `PUBLIC_ORIGIN` | The origin the app is served from, such as `https://hako.example.com`. Requests and WebSockets from any other origin are refused. Several origins can be given, separated by commas. Cookies are marked `Secure` when every origin is HTTPS. |
| `DATA_DIR` | Where `hako.db` lives. Defaults to `./.data`. |
| `PORT` | Defaults to `8787`. |

Generate the two secrets with something like `openssl rand -base64 36`.

## Deploy to Railway

The repository has a `Dockerfile` and a `railway.json` that sets the health check to `/api/health`.

1. Create a service in a Railway project and attach a volume mounted at `/data`.
2. Set the variables above on the service, with `DATA_DIR=/data` and `PUBLIC_ORIGIN` set to the
   public URL you will use.
3. Deploy, either with `railway up` from this folder or by connecting the GitHub repository.
4. Add your domain to the service and create the DNS records Railway asks for.

Run exactly one replica: the relay holds the agent connection and the SQLite file in one process.

Then point the desktop app at `wss://<your domain>/ws/agent` with the same `HAKO_AGENT_KEY`.

## Security

Be clear about what this is: **it puts a shell on your computer on the public internet, behind one
password.** Anyone who has that password, or a logged-in session, can do what you can do in a
terminal on your Mac. Anyone who has the agent key can pose as your Mac to the relay.

What stands in the way:

- One account, no sign-up, and a password stored as a salted scrypt hash.
- Five wrong passwords for an email block further tries for 15 minutes.
- Sessions are random ids in an HttpOnly, Secure, SameSite=Lax cookie, valid 30 days, stored hashed.
  Changing the password ends every other session.
- `/ws/client` needs a valid session and an `Origin` header equal to `PUBLIC_ORIGIN`; `/ws/agent`
  needs the agent key, compared in constant time.

What does not:

- **Data is protected by TLS only.** There is no end-to-end encryption between the browser and the
  Mac. The relay, and whoever runs or compromises the machine it is on, can read and change
  everything that passes through, including what you type into a terminal.
- There is no second factor.
- A stolen, unlocked phone with the app open is a terminal on your Mac.

So use a long password that you use nowhere else, keep the agent key and the session secret out of
the repository, and host the relay somewhere you trust. If you do not need remote access for a
while, quit Hako on the Mac or stop the relay.

## Licence

[MIT](LICENSE). The folder icons in `public/folder-icons` come from Material Icon Theme and carry
their own [MIT licence](public/folder-icons/LICENSE).
