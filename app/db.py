from datetime import datetime, timezone

from sqlalchemy import BigInteger, DateTime, Integer, String, Text, create_engine
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, sessionmaker

from .config import settings


def now() -> datetime:
    """Naive UTC timestamp (portable across SQLite and Postgres)."""
    return datetime.now(timezone.utc).replace(tzinfo=None)


_url = settings.database_url
if _url.startswith("postgres://"):
    _url = "postgresql+psycopg://" + _url[len("postgres://"):]
elif _url.startswith("postgresql://"):
    _url = "postgresql+psycopg://" + _url[len("postgresql://"):]

if _url.startswith("sqlite"):
    engine = create_engine(_url, connect_args={"check_same_thread": False})
else:
    engine = create_engine(_url, pool_pre_ping=True, pool_size=10, max_overflow=20)

SessionLocal = sessionmaker(engine, expire_on_commit=False)


class Base(DeclarativeBase):
    pass


class User(Base):
    __tablename__ = "users"
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    email: Mapped[str] = mapped_column(String(254), unique=True, index=True)
    password_hash: Mapped[str] = mapped_column(String(100))
    created_at: Mapped[datetime] = mapped_column(DateTime, default=now)


class Agent(Base):
    __tablename__ = "agents"
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    user_id: Mapped[int] = mapped_column(Integer, index=True)
    name: Mapped[str] = mapped_column(String(32))
    emoji: Mapped[str] = mapped_column(String(16), default="🤖")
    # One line describing what the agent is for; the router reads this.
    role: Mapped[str] = mapped_column(String(160), default="")
    instructions: Mapped[str] = mapped_column(Text, default="")
    created_at: Mapped[datetime] = mapped_column(DateTime, default=now)


class Doc(Base):
    __tablename__ = "docs"
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    agent_id: Mapped[int] = mapped_column(Integer, index=True)
    title: Mapped[str] = mapped_column(String(160))
    chars: Mapped[int] = mapped_column(Integer, default=0)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=now)


class Chunk(Base):
    __tablename__ = "chunks"
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    doc_id: Mapped[int] = mapped_column(Integer, index=True)
    agent_id: Mapped[int] = mapped_column(Integer, index=True)
    text: Mapped[str] = mapped_column(Text)


class Memory(Base):
    """Facts about the user, shared by every agent in their crew."""
    __tablename__ = "memories"
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    user_id: Mapped[int] = mapped_column(Integer, index=True)
    text: Mapped[str] = mapped_column(String(400))
    created_at: Mapped[datetime] = mapped_column(DateTime, default=now)


class TelegramLink(Base):
    __tablename__ = "telegram_links"
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    user_id: Mapped[int] = mapped_column(Integer, index=True)
    chat_id: Mapped[int] = mapped_column(BigInteger, unique=True, index=True)
    display: Mapped[str] = mapped_column(String(120), default="")
    # NULL means "auto": the dispatcher picks an agent per message.
    active_agent_id: Mapped[int | None] = mapped_column(Integer, nullable=True)
    last_agent_id: Mapped[int | None] = mapped_column(Integer, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=now)


class LinkToken(Base):
    __tablename__ = "link_tokens"
    token: Mapped[str] = mapped_column(String(64), primary_key=True)
    user_id: Mapped[int] = mapped_column(Integer, index=True)
    expires_at: Mapped[datetime] = mapped_column(DateTime)


class Message(Base):
    __tablename__ = "messages"
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    user_id: Mapped[int] = mapped_column(Integer, index=True)
    agent_id: Mapped[int | None] = mapped_column(Integer, nullable=True)
    chat_key: Mapped[str] = mapped_column(String(64), index=True)
    role: Mapped[str] = mapped_column(String(16))
    content: Mapped[str] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=now)


class KV(Base):
    __tablename__ = "kv"
    key: Mapped[str] = mapped_column(String(64), primary_key=True)
    value: Mapped[str] = mapped_column(Text)


def init_db() -> None:
    Base.metadata.create_all(engine)


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


def clean(text: str) -> str:
    """Postgres rejects NUL bytes in text columns."""
    return (text or "").replace("\x00", "")
