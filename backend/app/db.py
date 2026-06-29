"""SQLite 连接与会话管理。

单文件库，路径由环境变量 AILOGY_DB 决定，默认仓库根 ailogy.db。
启用 WAL + 外键 + busy_timeout，适配本地自托管下的并发读写。
"""
import os

from sqlalchemy import create_engine, event
from sqlalchemy.orm import declarative_base, sessionmaker

# 库文件路径：环境变量优先，否则仓库根 ailogy.db
_REPO_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
DB_PATH = os.environ.get("AILOGY_DB") or os.path.join(_REPO_ROOT, "ailogy.db")
DB_URL = f"sqlite:///{DB_PATH}"

# check_same_thread=False：FastAPI 多线程下复用连接（配合每请求一个 Session）
engine = create_engine(DB_URL, connect_args={"check_same_thread": False}, future=True)
SessionLocal = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False, future=True)
Base = declarative_base()


@event.listens_for(engine, "connect")
def _sqlite_pragma(dbapi_conn, _record):
    """每个连接建立时设 PRAGMA：WAL 提升并发、外键约束、忙等超时。"""
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
    """建表（含 import 触发 models 注册）+ FTS5 虚拟表与同步触发器。幂等。"""
    from . import models  # noqa: F401 注册所有表到 Base.metadata
    Base.metadata.create_all(bind=engine)
    _init_fts()


def _init_fts():
    """建立 entries 的 FTS5 全文索引与同步触发器（搜索用，零额外依赖）。"""
    with engine.begin() as conn:
        from sqlalchemy import text
        conn.execute(text(
            "CREATE VIRTUAL TABLE IF NOT EXISTS entries_fts USING fts5("
            "title, summary, name, project, "
            "content='entries', content_rowid='id', tokenize='unicode61')"
        ))
        # 插入 / 更新 / 删除 entries 时同步 FTS 影子表
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
