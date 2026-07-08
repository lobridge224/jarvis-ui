# Jarvis

A personal AI console that runs on your own computer, has real access to a
workspace folder you control, and is reachable from your phone, laptop, or
any browser.

## 1. Install

```
cd jarvis
npm install
cp .env.example .env
```

Open `.env` and fill in:
- `ANTHROPIC_API_KEY` — from console.anthropic.com → API Keys
- `AUTH_TOKEN` — any long random string, e.g. run `openssl rand -hex 24`
- `WORKSPACE_DIR` — optional; defaults to the `workspace/` folder in this
  project. Point it at a real folder once you trust the setup, but start
  scoped — don't hand it your whole home directory on day one.

## 2. Run it

```
npm start
```

Visit `http://localhost:3000`, paste your `AUTH_TOKEN` into the gate, and
you're talking to Jarvis. It can list, read, and write files inside
`WORKSPACE_DIR` — try asking it to list what's there.

Edit `persona.txt` any time to change how Jarvis talks or what it
prioritizes — no restart needed beyond a page refresh... actually a server
restart is needed since it's read per-request but cached by your OS's file
reads only, not memory — just save the file, it's read fresh every message.

## 3. Reach it from your phone and other devices

Right now it only listens on your computer. Three ways to reach it
elsewhere, roughly in order of what I'd actually recommend:

**Tailscale (recommended)** — creates a private network between your own
devices only; nothing is exposed publicly.
1. Install Tailscale on this computer and on your phone (tailscale.com/download)
2. Log into the same Tailscale account on both
3. On your phone, open `http://<this-computer's-tailscale-name>:3000`

**Cloudflare Tunnel** — gives you a real HTTPS URL, still no open ports:
```
cloudflared tunnel --url http://localhost:3000
```
Anyone with the URL could reach it, which is why the `AUTH_TOKEN` gate
matters here — don't skip setting a real one.

**ngrok** — quickest to try, free tier URLs change each restart:
```
ngrok http 3000
```

## Security notes (read this before exposing it)

- Anything reachable from the internet with file-write access is worth
  taking seriously. Tailscale is the safest option because it's never
  public — only your own logged-in devices can reach it at all.
- Keep `WORKSPACE_DIR` scoped to a specific folder, not your whole machine.
- `AUTH_TOKEN` is your only gate if you use Cloudflare Tunnel or ngrok —
  make it long and random, and don't reuse a password from elsewhere.
- Conversation history is stored unencrypted in `data/history.json`.
- Nothing here rate-limits API spend — a runaway loop could burn through
  Console credits. Set a spend limit on your Console workspace as a backstop.

## Running this on Render instead of your own PC

If you want Jarvis to be "the website," not something local, a few things change:

**Set up the repo and deployment (one-time):**
1. Create a new GitHub repo, push this project's code to it.
2. On Render: New → Web Service → connect that repo. Runtime: Node. Build command
   `npm install`, start command `npm start`.
3. Add your env vars in Render's dashboard (same ones as `.env` — `ANTHROPIC_API_KEY`,
   `AUTH_TOKEN`, etc.), plus the three GitHub ones below.
4. Generate a GitHub Personal Access Token (Settings → Developer settings → Fine-
   grained tokens) scoped to just this one repo, with **Contents: Read and write**
   permission. Nothing broader than that.
5. Set `GITHUB_TOKEN` (the token), `GITHUB_REPO` (`youruser/your-repo-name`), and
   `GITHUB_BRANCH` (usually `main`) in Render's environment variables.

**Once those are set, self-editing changes behavior automatically** — no code change
needed. `propose_ui_change` and `create_tool` approvals commit straight to GitHub
instead of writing local disk, and Render picks up the new commit and redeploys on
its own. You'll see this in the UI: the approve button will say "pushed to
`youruser/your-repo` — Render will rebuild shortly" instead of the old local-restart
message.

**This is actually a nicer safety net than the local one, not a worse one** — every
self-edit is now a real, visible git commit. `git log` is your history, `git revert`
undoes a specific one, and Render's own dashboard has a **Rollback** button (you've
already used it) that reverts to any previous successful deploy in a couple clicks.
You don't need `npm run rollback` for a Render-hosted instance; that script is for
local-disk mode only.

**One real gap, worth knowing rather than discovering the hard way:** conversation
history and the uploaded-files list (`data/history.json`, `data/files.json`) still
live on local disk, and Render's filesystem is wiped on every redeploy. That means
right now, approving a self-edit — or any redeploy for any reason — will reset
Jarvis's memory of your conversation. Your actual uploaded files are safe regardless
(they live at Anthropic via the Files API, not on Render's disk) — it's specifically
the conversation history and the "which files are in my library" list that reset.
Fixing this properly means moving that data to a real database (Render Postgres is
the natural choice) instead of local JSON files — a real but separate piece of work,
not something to solve by accident while focused on the self-editing feature.

## Self-editing the UI itself (higher stakes — read this one fully)

Jarvis can also propose changes to its own interface — `app.js`, `style.css`, or
`index.html` — via `propose_ui_change`. This is a bigger deal than adding a new tool,
because a broken tool fails in isolation, while a broken UI file can take down the
entire interface, including the panel you'd normally use to fix it. The system is
built around that specific risk:

**Before you approve anything:**
- Every proposal is shown as an actual diff (green = added, red/strikethrough =
  removed) in the **ui** panel — review what changed, not just "trust it."
- `app.js` gets a real syntax check before it's even staged. `style.css` gets a brace-
  balance check. `index.html` gets checked against every element ID the current
  `app.js` actually uses — if your proposed HTML would remove something JS depends on,
  it's rejected automatically before you ever see it.
- None of that guarantees a change won't break something at runtime in some other way
  — it catches the most likely failure modes, not all of them.

**What happens when you approve:**
- The entire current `public/` folder is backed up first, automatically, timestamped,
  in `backups/`. The last 20 are kept.
- The new file is written. No restart needed for UI files — just refresh your browser.

**If something breaks anyway:**
```
npm run rollback:list    # see available backups
npm run rollback         # restore the most recent one
npm run rollback <name>  # restore a specific one
```
This script deliberately does not depend on Express, the server, or the browser UI —
it's plain Node reading and copying files. It'll work even if `app.js` is completely
broken and the page won't load at all. That's the actual safety net; the review panel
is just where you'd normally catch problems before they happen.

**Recommended habit:** since we set up git earlier, commit before letting Jarvis make
UI changes for the day (`git add -A && git commit -m "checkpoint"`), so you've got a
second, independent way back on top of the backup folder.

## Self-extension (Jarvis can propose its own tools)

Ask Jarvis for a capability it doesn't have, and it can write the tool itself using a
built-in `create_tool` ability. New tools land in `tools/pending/` — **they do not run
automatically.** Open the **tools** panel in the UI to see the name, description, and
the actual code, then approve or reject.

Approving moves the file into `tools/`, and the server (via `nodemon`) automatically
restarts to load it — takes a few seconds, your conversation history isn't lost.

**Read this before approving anything, not just skimming it:** a self-written tool runs
with the same privileges as the rest of the server — there's no sandbox. It can make
network requests, read/write files anywhere `server.js` has permission to, or worse if
you let it. The syntax check only catches broken code, not malicious code. Since web
search is also enabled, there's a real (if unlikely) scenario where something Jarvis
reads online tries to talk it into writing a tool that does something you wouldn't
want — that's exactly why this is staged for approval instead of automatic. Treat the
tools panel the way you'd treat reviewing a pull request: actually read it once before
clicking approve, especially anything that touches the network, `process.env`, or
paths outside the workspace.

`npm start` uses `nodemon` now instead of plain `node` so approved tools take effect
automatically. If you ever want to run it without auto-restart, `npm run start:once`
still works exactly like before.

## File library (upload once, use from any device)

Click **files** in the top bar to open the library. Uploads go straight to
Anthropic's Files API — the actual bytes live in your Anthropic account, not
on whichever computer happens to be running the server. Click a file to
attach it to your next message; Jarvis can also list what's in the library
on its own if you ask.

Notes:
- This uses a beta API (`files-api-2025-04-14`) — the request shape for
  attaching files to a message may shift slightly as it matures. If an
  attach request errors, check platform.claude.com/docs/en/build-with-claude/files
  for the current schema.
- Upload size is capped at 30MB per file in this server (`server.js`, the
  `multer` limit) — raise it if you need to, but very large files also cost
  more in tokens every time Claude reads them.
- Deleting a file in the library deletes it from Anthropic's storage too,
  not just the local list.

## What it can't do yet

- No scheduled/background tasks — it only acts when you message it.
- No access to your browser or other apps — just the files in `WORKSPACE_DIR`.
- Single conversation thread — it's one continuous memory, not separate
  chats. Use the "reset" button to start fresh.

Both are straightforward to add later (a cron-style scheduler for the
first, more tool definitions for the second) once the basics feel solid.
