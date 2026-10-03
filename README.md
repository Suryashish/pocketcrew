# 🛟 PocketCrew

**Your own crew of AI agents, living in one Telegram chat. Powered only by Google's Gemma.**

Sign up, describe an agent in one sentence, tap once to connect Telegram, and start chatting.
No bot to create per user, no webhooks, no prompt engineering.

## What makes it different

- **One chat, many specialists.** You don't pick an agent per message. A Gemma dispatcher reads
  each message and hands it to the agent whose role fits best. `@Name` talks to one directly.
- **Hire in a sentence.** Type `a strict Spanish tutor` on the web or `/hire a strict Spanish tutor`
  in Telegram, and Gemma writes the name, role and instructions.
- **Agents that act.** Each agent can search the web, run commands on a Linux sandbox, and build and
  host a web page, then send you the link.
- **Build by voice.** In the dashboard the app asks four questions out loud, you answer by speaking,
  and Gemma builds and saves the agent. Speech uses the browser's own engine, so Gemma stays the only model.
- **Teach by sending files.** Send a `.txt`, `.md` or `.pdf` to the bot and the agent answers from it.
- **One shared memory.** `/remember I'm vegetarian` once, and every agent knows.
- **One-tap Telegram linking.** A deep link or QR code. Users never touch BotFather.
- **Small and self-hostable.** Three containers, one model, no vector database, no build step.

## Quick start

You need Docker and two free keys:

1. A Gemma API key from [Google AI Studio](https://aistudio.google.com/apikey)
2. A Telegram bot token from [@BotFather](https://t.me/BotFather) (send it `/newbot`)

```bash
cp .env.example .env      # paste the two keys into .env
docker compose up -d
```

Open <http://localhost:8000>, sign up, and press **Connect Telegram**.

The bot uses long polling, so this works from a laptop with no public URL.

## Using it from Telegram

| You send | What happens |
| --- | --- |
| any message | the best-suited agent answers (auto mode) |
| `@Coder why is this slow?` | that agent answers |
| `/agents` | see your crew, pin one agent, or return to auto |
| `/hire a calm meditation guide` | creates a new agent |
| a `.txt` / `.md` / `.pdf` file | the agent learns it (caption `@Name` to choose which) |
| `/remember …`, `/memory`, `/forget` | manage the memory all agents share |
| `/new` | start a fresh conversation |
| `/unlink` | disconnect the chat |

## Agent tools and the sandbox

Agents with "Give it a computer and the internet" switched on (the default) can use five tools:

| Tool | What it does |
| --- | --- |
| `web_search` | Search the web (DuckDuckGo, no API key) |
| `fetch_url` | Read a web page as text |
| `shell` | Run a bash command (Debian, Python 3, Node.js, git, curl; no root; 120 s per command) |
| `write_file` | Create or overwrite a file in the agent's workspace |
| `serve` | Start a web server and return a public link, `PUBLIC_URL/p/<token>/` |

Ask an agent to *"build a landing page for my cafe and send me the link"* and it writes the files,
starts a server and replies with a link you can open. In Telegram you see each step as it happens.

How it is built, and what that means for safety:

- **One shared sandbox container** runs everyone's commands. Each agent has its own folder
  (`/workspace/<agent id>`) and its own preview port. Agents are separated by folder, **not by a
  security boundary**: one agent's commands can read another agent's files. Do not put secrets in
  the sandbox, and treat it as a shared machine. Per-user containers are the natural next step.
- The sandbox is unprivileged: non-root user, all Linux capabilities dropped, no new privileges,
  and memory, CPU and process limits. It is on its own network and **cannot reach the database**.
  It does have outbound internet access.
- The API never touches the Docker socket. It talks to a small command runner inside the sandbox
  over an internal network.
- Preview pages are untrusted content. They are served with `Content-Security-Policy: sandbox`, so a
  page an agent built cannot call the PocketCrew API as the person viewing it. Anyone with a
  preview link can open it.
- Preview links use `PUBLIC_URL`. With the default `http://localhost:8000` they only open on the
  machine running the stack; set `PUBLIC_URL` to a reachable address for links to work from a phone.
- Set `TOOLS_ENABLED=false` to switch tools off for everyone, or untick the box on a single agent.

## Configuration

Everything lives in `.env` (see [.env.example](.env.example)).

| Variable | Default | Purpose |
| --- | --- | --- |
| `GEMINI_API_KEY` | | Google AI Studio key used to call Gemma |
| `TELEGRAM_BOT_TOKEN` | | The platform's Telegram bot |
| `LLM_MODEL` | `gemma-3-27b-it` | Any Gemma model. Non-Gemma models are refused at startup |
| `PUBLIC_URL` | `http://localhost:8000` | Where users reach the dashboard; use `https://…` in production |
| `PORT` | `8000` | Host port for the dashboard |
| `SECRET_KEY` | generated | Signs login sessions |
| `DATABASE_URL` | bundled Postgres | Point at a hosted Postgres such as Neon |
| `ALLOW_SIGNUPS` | `true` | Set `false` to close registration |
| `MAX_AGENTS_PER_USER` | `12` | Crew size limit |
| `TOOLS_ENABLED` | `true` | Web search and the sandbox for agents |
| `SANDBOX_MEMORY`, `SANDBOX_CPUS` | `2g`, `2` | Limits for the shared sandbox container |
| `MAX_TOOL_STEPS` | `8` | Tool rounds an agent may take per message |

### Running Gemma locally instead

```bash
# in .env
LLM_BASE_URL=http://ollama:11434/v1
LLM_MODEL=gemma3:4b
```

```bash
docker compose --profile local up -d   # also starts Ollama and pulls the model
```

### Going to production

Put a TLS-terminating reverse proxy (Caddy, nginx, Traefik) in front of port 8000 (it should set
`X-Forwarded-For`, which the per-address rate limits rely on), set
`PUBLIC_URL` to your `https://` address and change `POSTGRES_PASSWORD`. Run a single `bot`
container: Telegram allows one poller per bot token.

## How it works

```
Browser ──► web (Next.js) ──/api──► api (FastAPI) ──┬──► sandbox (shared Linux container)
                                                    ├──► Postgres
Telegram ◄──────────────────► bot (long polling) ───┘
                                 │
                                 └──► Gemma (Google AI Studio, or Ollama)
```

The browser only talks to the Next.js app. It serves the landing page and dashboard and forwards
`/api/*` to FastAPI, so the session cookie stays first-party and the API is never exposed directly.

Backend (`app/`)
- `main.py`: REST API
- `bot.py`: Telegram worker (commands, linking, file learning)
- `brain.py`: prompt assembly, dispatcher, agent drafting
- `knowledge.py`: chunking and BM25 retrieval (no embeddings, no extra model)
- `tools.py`, `sandbox.py`: the tool protocol and the client for the sandbox (`sandbox/runner.py`)
- `llm.py`: Gemma client. Gemma has no system role and needs alternating turns, so prompts are shaped for that

Frontend (`frontend/`, Next.js App Router + TypeScript)
- `app/page.tsx`, `app/dashboard/page.tsx`: the two routes
- `app/api/[...path]/route.ts`: the gateway to FastAPI
- `components/`: landing page, dashboard, agent editor, voice builder
- `lib/landing.ts`: the WebGL orb and animated illustrations

## Development

```bash
# API on :8001 (SQLite, no Docker needed)
python -m venv .venv && . .venv/bin/activate
pip install -r requirements-dev.txt
pytest                                   # runs with a fake model
GEMINI_API_KEY=… uvicorn app.main:app --reload --port 8001

# Frontend on :3000, forwarding /api to the API above
cd frontend && npm install && npm run dev
```

## License

MIT
