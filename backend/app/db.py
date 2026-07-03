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
    """建表 + 轻量列迁移 + FTS5 虚拟表与同步触发器 + AI 队列触发器。幂等。"""
    from . import models  # noqa: F401
    Base.metadata.create_all(bind=engine)
    _migrate()
    _init_fts()
    _init_ai_triggers()


def _migrate():
    """对既有 entries / ai_insights 表补新列（create_all 不会给已存在的表加列）。"""
    from sqlalchemy import text
    with engine.begin() as conn:
        cols = {r[1] for r in conn.execute(text("PRAGMA table_info(entries)"))}
        if "device" not in cols:
            conn.execute(text("ALTER TABLE entries ADD COLUMN device TEXT DEFAULT ''"))
        if "color" not in cols:
            conn.execute(text("ALTER TABLE entries ADD COLUMN color TEXT"))
        # ai_insights 由 demo 版演进：补 client_id / day（旧 demo 行会被后续全量回填重建）
        ins = {r[1] for r in conn.execute(text("PRAGMA table_info(ai_insights)"))}
        if ins:  # 表已存在才需补列
            if "client_id" not in ins:
                conn.execute(text("ALTER TABLE ai_insights ADD COLUMN client_id TEXT DEFAULT ''"))
            if "day" not in ins:
                conn.execute(text("ALTER TABLE ai_insights ADD COLUMN day TEXT DEFAULT ''"))


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


def _init_ai_triggers():
    """entries 上的 AI 变更触发器：把增/改/删记账到 ai_queue，供 worker 消费。

    - 只记「客户端业务键 client_id + 操作」，不在触发器里调用 AI（SQLite 也做不到）。
    - 重复变更走 ON CONFLICT 合并为「重置为待处理」，避免同一条堆多行。
    - UPDATE 仅当影响 AI 的列（标题/正文/项目/设备/时间）变化时才入队，改颜色等不触发重算。
    - 触发器写入必须与 models.AIQueue 的列/默认值一致。
    """
    from sqlalchemy import text
    with engine.begin() as conn:
        # 确保 ai_queue 已建（create_all 已建过；这里仅防御）
        conn.execute(text(
            "CREATE TABLE IF NOT EXISTS ai_queue ("
            "client_id TEXT PRIMARY KEY, op TEXT DEFAULT 'upsert', "
            "need_insight INTEGER DEFAULT 1, need_embed INTEGER DEFAULT 1, "
            "attempts INTEGER DEFAULT 0, paused INTEGER DEFAULT 0, last_error TEXT DEFAULT '', "
            "enqueued_at DATETIME, updated_at DATETIME)"))
        # INSERT：新日志入队，两条流水线都待处理
        conn.execute(text(
            "CREATE TRIGGER IF NOT EXISTS entries_ai_enq_ins AFTER INSERT ON entries BEGIN "
            "INSERT INTO ai_queue (client_id, op, need_insight, need_embed, attempts, paused, last_error, enqueued_at, updated_at) "
            "VALUES (new.client_id, 'upsert', 1, 1, 0, 0, '', datetime('now'), datetime('now')) "
            "ON CONFLICT(client_id) DO UPDATE SET op='upsert', need_insight=1, need_embed=1, "
            "attempts=0, paused=0, last_error='', updated_at=datetime('now'); END"))
        # UPDATE：仅 AI 相关列变化才重排；两条流水线都重置
        conn.execute(text(
            "CREATE TRIGGER IF NOT EXISTS entries_ai_enq_upd AFTER UPDATE ON entries "
            "WHEN old.title IS NOT new.title OR old.summary IS NOT new.summary "
            "OR old.project IS NOT new.project OR old.device IS NOT new.device "
            "OR old.datetime IS NOT new.datetime BEGIN "
            "INSERT INTO ai_queue (client_id, op, need_insight, need_embed, attempts, paused, last_error, enqueued_at, updated_at) "
            "VALUES (new.client_id, 'upsert', 1, 1, 0, 0, '', datetime('now'), datetime('now')) "
            "ON CONFLICT(client_id) DO UPDATE SET op='upsert', need_insight=1, need_embed=1, "
            "attempts=0, paused=0, last_error='', updated_at=datetime('now'); END"))
        # DELETE：入队删除任务，worker 据此清 insight/embedding 并标记主题重汇总
        conn.execute(text(
            "CREATE TRIGGER IF NOT EXISTS entries_ai_enq_del AFTER DELETE ON entries BEGIN "
            "INSERT INTO ai_queue (client_id, op, need_insight, need_embed, attempts, paused, last_error, enqueued_at, updated_at) "
            "VALUES (old.client_id, 'delete', 0, 0, 0, 0, '', datetime('now'), datetime('now')) "
            "ON CONFLICT(client_id) DO UPDATE SET op='delete', need_insight=0, need_embed=0, "
            "attempts=0, paused=0, last_error='', updated_at=datetime('now'); END"))
