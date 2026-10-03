"""PocketCrew API. The dashboard is the Next.js app in frontend/, which proxies /api here."""
import logging
import re
import secrets
import threading
import time
from collections import defaultdict, deque
from contextlib import asynccontextmanager
from datetime import timedelta

import httpx
import segno
from fastapi import Depends, FastAPI, File, HTTPException, Request, Response, UploadFile
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field
from sqlalchemy import delete, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from . import brain, knowledge, llm, security
from .config import settings
from .db import Agent, Doc, Chunk, LinkToken, Memory, Message, TelegramLink, User, clean, get_db, init_db, now
from .telegram import Telegram, TelegramError

log = logging.getLogger("pocketcrew.web")
EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
LINK_TOKEN_MINUTES = 15


@asynccontextmanager
async def lifespan(app: FastAPI):
    logging.getLogger("httpx").setLevel(logging.WARNING)  # request logs would leak the bot token
    settings.validate()
    init_db()
    security.secret()
    yield


app = FastAPI(title="PocketCrew", lifespan=lifespan, docs_url="/api/docs", redoc_url=None, openapi_url="/api/openapi.json")


@app.exception_handler(RequestValidationError)
async def validation_error(request: Request, exc: RequestValidationError):
    """One readable sentence instead of pydantic's nested error list."""
    first = exc.errors()[0] if exc.errors() else {}
    field = str((first.get("loc") or ["input"])[-1]).replace("_", " ").capitalize()
    return JSONResponse({"detail": f"{field}: {first.get('msg', 'invalid value')}."}, status_code=422)


# --- helpers ---------------------------------------------------------------

_attempts: dict[str, deque] = defaultdict(deque)
_attempts_lock = threading.Lock()


def throttle(key: str, limit: int, window: int = 300) -> None:
    """Small in-memory brake: at most `limit` attempts per `window` seconds for `key`."""
    with _attempts_lock:
        q = _attempts[key]
        cutoff = time.time() - window
        while q and q[0] < cutoff:
            q.popleft()
        if len(q) >= limit:
            raise HTTPException(429, "Too many attempts. Please wait a few minutes.")
        q.append(time.time())


def client_ip(request: Request) -> str:
    # Behind the Next.js gateway this is only a real visitor address when a
    # reverse proxy in front sets X-Forwarded-For; otherwise everyone shares
    # one address, which is why the per-address limits below are loose.
    return request.client.host if request.client else "unknown"


def current_user(request: Request, db: Session = Depends(get_db)) -> User:
    user_id = security.read_session(request.cookies.get(security.COOKIE, ""))
    user = db.get(User, user_id) if user_id else None
    if not user:
        raise HTTPException(401, "Please log in.")
    return user


def own_agent(agent_id: int, user: User = Depends(current_user), db: Session = Depends(get_db)) -> Agent:
    agent = db.get(Agent, agent_id)
    if not agent or agent.user_id != user.id:
        raise HTTPException(404, "Agent not found.")
    return agent


def set_session(response: Response, user: User) -> None:
    response.set_cookie(
        security.COOKIE, security.make_session(user.id), max_age=security.SESSION_SECONDS,
        httponly=True, samesite="lax", secure=settings.cookie_secure, path="/",
    )


def agent_json(a: Agent) -> dict:
    return {"id": a.id, "name": a.name, "emoji": a.emoji, "role": a.role, "instructions": a.instructions}


_bot_lock = threading.Lock()
_bot_cache: tuple[float, str] = (0.0, "")


def bot_username() -> str:
    """The platform bot's @username, or '' when Telegram isn't set up."""
    global _bot_cache
    if not settings.telegram_token:
        return ""
    with _bot_lock:
        checked, name = _bot_cache
        if name or time.time() - checked < 30:
            return name
        try:
            tg = Telegram(settings.telegram_token, settings.telegram_api_base)
            name = tg.call("getMe", _timeout=8).get("username") or ""
        except (TelegramError, httpx.HTTPError) as e:
            log.warning("Could not reach Telegram: %s", e)
            name = ""
        _bot_cache = (time.time(), name)
        return name


# --- schemas ---------------------------------------------------------------

class Credentials(BaseModel):
    email: str = Field(max_length=254)
    password: str = Field(min_length=8, max_length=200)


class AgentIn(BaseModel):
    name: str = Field(min_length=1, max_length=32)
    emoji: str = Field(default="🤖", max_length=16)
    role: str = Field(default="", max_length=160)
    instructions: str = Field(default="", max_length=4000)


class DraftIn(BaseModel):
    description: str = Field(min_length=4, max_length=600)


class InterviewTurn(BaseModel):
    question: str = Field(max_length=200)
    answer: str = Field(max_length=1000)


class InterviewIn(BaseModel):
    answers: list[InterviewTurn] = Field(min_length=1, max_length=6)


class DocIn(BaseModel):
    title: str = Field(default="", max_length=160)
    text: str = Field(min_length=1, max_length=400_000)


class ChatIn(BaseModel):
    message: str = Field(min_length=1, max_length=6000)


class MemoryIn(BaseModel):
    text: str = Field(min_length=1, max_length=400)


# --- status & auth ---------------------------------------------------------

@app.get("/healthz")
def healthz():
    return {"ok": True}


@app.get("/api/status")
def status():
    return {
        "llm": llm.status(),
        "telegram": {"configured": bool(settings.telegram_token), "bot": bot_username()},
        "signups": settings.allow_signups,
    }


@app.post("/api/auth/signup")
def signup(body: Credentials, request: Request, response: Response, db: Session = Depends(get_db)):
    if not settings.allow_signups:
        raise HTTPException(403, "Signups are closed on this server.")
    throttle(f"signup:{client_ip(request)}", limit=30)
    email = body.email.strip().lower()
    if not EMAIL_RE.match(email):
        raise HTTPException(422, "That doesn't look like an email address.")
    user = User(email=email, password_hash=security.hash_password(body.password))
    db.add(user)
    try:
        db.flush()
    except IntegrityError:
        db.rollback()
        raise HTTPException(409, "An account with that email already exists. Try logging in.")
    # Everyone starts with one agent so Telegram works the moment it's linked.
    db.add(Agent(user_id=user.id, **brain.STARTER))
    db.commit()
    set_session(response, user)
    return {"id": user.id, "email": user.email}


@app.post("/api/auth/login")
def login(body: Credentials, request: Request, response: Response, db: Session = Depends(get_db)):
    email = body.email.strip().lower()
    # Per account, so guessing one password is slow whatever address it comes from.
    throttle(f"login:{email}", limit=10)
    throttle(f"login-ip:{client_ip(request)}", limit=120)
    user = db.scalar(select(User).where(User.email == email))
    if not user or not security.verify_password(body.password, user.password_hash):
        raise HTTPException(401, "Wrong email or password.")
    set_session(response, user)
    return {"id": user.id, "email": user.email}


@app.post("/api/auth/logout")
def logout(response: Response):
    response.delete_cookie(security.COOKIE, path="/")
    return {"ok": True}


@app.get("/api/me")
def me(user: User = Depends(current_user)):
    return {"id": user.id, "email": user.email}


# --- agents ----------------------------------------------------------------

def _validated(body: AgentIn, existing: list[Agent], editing: Agent | None = None) -> dict:
    name = " ".join(clean(body.name).split())
    if not brain.valid_name(name):
        raise HTTPException(422, "Agent names can use letters, numbers, spaces and dashes (max 32).")
    if any(a.name.lower() == name.lower() and a is not editing for a in existing):
        raise HTTPException(409, f"You already have an agent called {name}.")
    return {
        "name": name,
        "emoji": clean(body.emoji).strip() or "🤖",
        "role": " ".join(clean(body.role).split()),
        "instructions": clean(body.instructions).strip(),
    }


@app.get("/api/agents")
def list_agents(user: User = Depends(current_user), db: Session = Depends(get_db)):
    return [agent_json(a) for a in brain.agents_of(db, user.id)]


@app.post("/api/agents")
def create_agent(body: AgentIn, user: User = Depends(current_user), db: Session = Depends(get_db)):
    existing = brain.agents_of(db, user.id)
    if len(existing) >= settings.max_agents:
        raise HTTPException(409, f"Your crew is full ({settings.max_agents} agents).")
    agent = Agent(user_id=user.id, **_validated(body, existing))
    db.add(agent)
    db.commit()
    return agent_json(agent)


@app.post("/api/agents/draft")
def draft_agent(body: DraftIn, user: User = Depends(current_user), db: Session = Depends(get_db)):
    existing = brain.agents_of(db, user.id)
    db.commit()
    try:
        draft = brain.draft_agent(body.description)
    except llm.LLMError as e:
        raise HTTPException(503, str(e))
    draft["name"] = brain.unique_name(existing, draft["name"])
    return draft


@app.post("/api/agents/interview")
def interview_agent(body: InterviewIn, user: User = Depends(current_user), db: Session = Depends(get_db)):
    """Build and save an agent from the answers given in the voice interview."""
    if len(clean(body.answers[0].answer).strip()) < 3:
        raise HTTPException(422, "Tell me what the agent should help with first.")
    existing = brain.agents_of(db, user.id)
    if len(existing) >= settings.max_agents:
        raise HTTPException(409, f"Your crew is full ({settings.max_agents} agents).")
    db.commit()
    try:
        draft = brain.draft_from_interview([(t.question, t.answer) for t in body.answers])
    except llm.LLMError as e:
        raise HTTPException(503, str(e))
    draft["name"] = brain.unique_name(existing, draft["name"])
    agent = Agent(user_id=user.id, **draft)
    db.add(agent)
    db.commit()
    return agent_json(agent)


@app.patch("/api/agents/{agent_id}")
def update_agent(body: AgentIn, agent: Agent = Depends(own_agent), db: Session = Depends(get_db)):
    agent = db.merge(agent)
    existing = brain.agents_of(db, agent.user_id)
    current = next(a for a in existing if a.id == agent.id)
    for key, value in _validated(body, existing, editing=current).items():
        setattr(agent, key, value)
    db.commit()
    return agent_json(agent)


@app.delete("/api/agents/{agent_id}")
def remove_agent(agent: Agent = Depends(own_agent), db: Session = Depends(get_db)):
    brain.delete_agent(db, db.merge(agent))
    return {"ok": True}


# --- knowledge -------------------------------------------------------------

@app.get("/api/agents/{agent_id}/docs")
def list_docs(agent: Agent = Depends(own_agent), db: Session = Depends(get_db)):
    docs = db.scalars(select(Doc).where(Doc.agent_id == agent.id).order_by(Doc.id))
    return [{"id": d.id, "title": d.title, "chars": d.chars} for d in docs]


@app.post("/api/agents/{agent_id}/docs")
def add_text(body: DocIn, agent: Agent = Depends(own_agent), db: Session = Depends(get_db)):
    title = body.title.strip() or " ".join(body.text.split())[:60]
    try:
        doc = brain.add_doc(db, agent, title, body.text, settings.max_knowledge_chars)
    except ValueError as e:
        raise HTTPException(413, str(e))
    return {"id": doc.id, "title": doc.title, "chars": doc.chars}


@app.post("/api/agents/{agent_id}/docs/upload")
def upload_doc(file: UploadFile = File(...), agent: Agent = Depends(own_agent), db: Session = Depends(get_db)):
    data = file.file.read(settings.max_doc_bytes + 1)
    if len(data) > settings.max_doc_bytes:
        raise HTTPException(413, f"Files can be up to {settings.max_doc_bytes // 1_000_000} MB.")
    try:
        text = knowledge.extract_text(file.filename or "", data)
        doc = brain.add_doc(db, agent, file.filename or "Upload", text, settings.max_knowledge_chars)
    except knowledge.UnsupportedFile as e:
        raise HTTPException(415, str(e))
    except ValueError as e:
        raise HTTPException(413, str(e))
    return {"id": doc.id, "title": doc.title, "chars": doc.chars}


@app.delete("/api/docs/{doc_id}")
def remove_doc(doc_id: int, user: User = Depends(current_user), db: Session = Depends(get_db)):
    doc = db.get(Doc, doc_id)
    agent = db.get(Agent, doc.agent_id) if doc else None
    if not doc or not agent or agent.user_id != user.id:
        raise HTTPException(404, "Document not found.")
    db.execute(delete(Chunk).where(Chunk.doc_id == doc.id))
    db.delete(doc)
    db.commit()
    return {"ok": True}


# --- test chat in the dashboard ---------------------------------------------

@app.get("/api/agents/{agent_id}/chat")
def chat_history(agent: Agent = Depends(own_agent), db: Session = Depends(get_db)):
    rows = db.scalars(
        select(Message).where(Message.chat_key == f"web:{agent.id}").order_by(Message.id.desc()).limit(40)
    )
    return [{"role": m.role, "content": m.content} for m in reversed(list(rows))]


@app.post("/api/agents/{agent_id}/chat")
def chat(body: ChatIn, agent: Agent = Depends(own_agent), user: User = Depends(current_user), db: Session = Depends(get_db)):
    try:
        reply = brain.respond(db, user, agent, f"web:{agent.id}", body.message, "the web dashboard")
    except llm.LLMError as e:
        raise HTTPException(503, str(e))
    return {"reply": reply}


@app.delete("/api/agents/{agent_id}/chat")
def reset_chat(agent: Agent = Depends(own_agent), db: Session = Depends(get_db)):
    db.execute(delete(Message).where(Message.chat_key == f"web:{agent.id}"))
    db.commit()
    return {"ok": True}


# --- shared memory ----------------------------------------------------------

@app.get("/api/memory")
def list_memory(user: User = Depends(current_user), db: Session = Depends(get_db)):
    rows = db.scalars(select(Memory).where(Memory.user_id == user.id).order_by(Memory.id))
    return [{"id": m.id, "text": m.text} for m in rows]


@app.post("/api/memory")
def add_memory(body: MemoryIn, user: User = Depends(current_user), db: Session = Depends(get_db)):
    if len(list(db.scalars(select(Memory.id).where(Memory.user_id == user.id)))) >= 100:
        raise HTTPException(409, "Shared memory is full (100 facts). Remove some first.")
    row = Memory(user_id=user.id, text=clean(body.text).strip())
    db.add(row)
    db.commit()
    return {"id": row.id, "text": row.text}


@app.delete("/api/memory/{memory_id}")
def remove_memory(memory_id: int, user: User = Depends(current_user), db: Session = Depends(get_db)):
    row = db.get(Memory, memory_id)
    if not row or row.user_id != user.id:
        raise HTTPException(404, "Not found.")
    db.delete(row)
    db.commit()
    return {"ok": True}


# --- telegram ---------------------------------------------------------------

@app.get("/api/telegram")
def telegram_state(user: User = Depends(current_user), db: Session = Depends(get_db)):
    links = db.scalars(select(TelegramLink).where(TelegramLink.user_id == user.id).order_by(TelegramLink.id))
    return {
        "configured": bool(settings.telegram_token),
        "bot": bot_username(),
        "links": [{"id": l.id, "display": l.display} for l in links],
    }


@app.post("/api/telegram/link")
def telegram_link(user: User = Depends(current_user), db: Session = Depends(get_db)):
    bot = bot_username()
    if not bot:
        raise HTTPException(503, "Telegram isn't set up on this server yet (TELEGRAM_BOT_TOKEN).")
    db.execute(delete(LinkToken).where(LinkToken.user_id == user.id))
    token = secrets.token_urlsafe(24)
    db.add(LinkToken(token=token, user_id=user.id, expires_at=now() + timedelta(minutes=LINK_TOKEN_MINUTES)))
    db.commit()
    url = f"https://t.me/{bot}?start={token}"
    qr = segno.make(url, error="m").svg_inline(omitsize=True, border=2, dark="#111827", light="#ffffff")
    return {"url": url, "qr": qr, "minutes": LINK_TOKEN_MINUTES}


@app.delete("/api/telegram/links/{link_id}")
def telegram_unlink(link_id: int, user: User = Depends(current_user), db: Session = Depends(get_db)):
    link = db.get(TelegramLink, link_id)
    if not link or link.user_id != user.id:
        raise HTTPException(404, "Not found.")
    db.execute(delete(Message).where(Message.chat_key == f"tg:{link.chat_id}"))
    db.delete(link)
    db.commit()
    return {"ok": True}
