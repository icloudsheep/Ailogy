"""SQLite 连接与会话管理。

单文件库，路径由环境变量 AILOGY_DB 决定，默认仓库根 ailogy.db。
启用 WAL + 外键 + busy_timeout，适配本地自托管下的并发读写。
"""
from sqlalchemy import create_engine, event
from sqlalchemy.orm import declarative_base, sessionmaker

from .settings import DB_PATH

DB_URL = f"sqlite:///{DB_PATH}"

engine = create_engine(DB_URL, connect_args={"check_same_thread": False}, future=True)
SessionLocal = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False, future=True)
Base = declarative_base()


@event.listens_for(engine, "connect")
def _sqlite_pragma(dbapi_conn, _record):
    cur = dbapi_conn.cursor()
    cur.execute("PRAGMA journal_mode=WAL")
    cur.execute("PRAGMA foreign_keys=ON")
    cur.execute("PRAGMA busy_timeout=5000")
    cur.close()


def get_db():
    """FastAPI 依赖：每请求一个 Session，请求结束自动关闭。"""
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


def init_db():
    """建表 + 轻量列迁移 + FTS5 虚拟表与同步触发器。幂等。"""
    from . import models  # noqa: F401
    Base.metadata.create_all(bind=engine)
    _migrate()
    _init_fts()


def _migrate():
    """对既有 entries 表补新列（create_all 不会给已存在的表加列）。"""
    from sqlalchemy import text
    with engine.begin() as conn:
        cols = {r[1] for r in conn.execute(text("PRAGMA table_info(entries)"))}
        if "device" not in cols:
            conn.execute(text("ALTER TABLE entries ADD COLUMN device TEXT DEFAULT ''"))
        if "color" not in cols:
            conn.execute(text("ALTER TABLE entries ADD COLUMN color TEXT"))


def _init_fts():
    with engine.begin() as conn:
        from sqlalchemy import text
        conn.execute(text(
            "CREATE VIRTUAL TABLE IF NOT EXISTS entries_fts USING fts5("
            "title, summary, name, project, "
            "content='entries', content_rowid='id', tokenize='unicode61')"
        ))
        conn.execute(text(
            "CREATE TRIGGER IF NOT EXISTS entries_ai AFTER INSERT ON entries BEGIN "
            "INSERT INTO entries_fts(rowid, title, summary, name, project) "
            "VALUES (new.id, new.title, new.summary, new.name, new.project); END"))
        conn.execute(text(
            "CREATE TRIGGER IF NOT EXISTS entries_ad AFTER DELETE ON entries BEGIN "
            "INSERT INTO entries_fts(entries_fts, rowid, title, summary, name, project) "
            "VALUES('delete', old.id, old.title, old.summary, old.name, old.project); END"))
        conn.execute(text(
            "CREATE TRIGGER IF NOT EXISTS entries_au AFTER UPDATE ON entries BEGIN "
            "INSERT INTO entries_fts(entries_fts, rowid, title, summary, name, project) "
            "VALUES('delete', old.id, old.title, old.summary, old.name, old.project); "
            "INSERT INTO entries_fts(rowid, title, summary, name, project) "
            "VALUES (new.id, new.title, new.summary, new.name, new.project); END"))
