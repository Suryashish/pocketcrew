# 🛟 PocketCrew

**Your own crew of AI agents, living in one Telegram chat. Powered only by Google's Gemma.**

Sign up, describe an agent in one sentence, tap once to connect Telegram, and start chatting.
No bot to create per user, no webhooks, no prompt engineering.

## What makes it different

- **One chat, many specialists.** You don't pick an agent per message. A Gemma dispatcher reads
  each message and hands it to the agent whose role fits best. `@Name` talks to one directly.
- **Hire in a sentence.** Type `a strict Spanish tutor` on the web or `/hire a strict Spanish tutor`
  in Telegram, and Gemma writes the name, role and instructions.
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
| `ALLOW_SIGNUPS` | `true` | Set `false` to close registration |
| `MAX_AGENTS_PER_USER` | `12` | Crew size limit |

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

Put a TLS-terminating reverse proxy (Caddy, nginx, Traefik) in front of port 8000, set
`PUBLIC_URL` to your `https://` address and change `POSTGRES_PASSWORD`. Run a single `bot`
container: Telegram allows one poller per bot token.

## How it works

```
Browser ──► web (FastAPI + static dashboard) ──┐
                                               ├──► Postgres
Telegram ◄─► bot (long-polling worker) ────────┘
                 │
                 └──► Gemma (Google AI Studio, or Ollama)
```

- `app/main.py`: REST API and dashboard
- `app/bot.py`: Telegram worker (commands, linking, file learning)
- `app/brain.py`: prompt assembly, dispatcher, agent drafting
- `app/knowledge.py`: chunking and BM25 retrieval (no embeddings, no extra model)
- `app/llm.py`: Gemma client. Gemma has no system role and needs alternating turns, so prompts are shaped for that

## Development

```bash
python -m venv .venv && . .venv/bin/activate
pip install -r requirements-dev.txt
pytest                                   # runs on SQLite with a fake model
GEMINI_API_KEY=… uvicorn app.main:app --reload
```

## License

MIT
