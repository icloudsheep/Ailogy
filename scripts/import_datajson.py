#!/usr/bin/env python3
"""把现有 ai-log 的 data.json（按天目录）一次性导入 Ailogy 数据库。

用途：M1 阶段灌入真实历史数据，供三视图瀑布流 / 搜索验证。
默认导入到 DEMO 用户（id=1，不存在则建一个占位用户）。

用法：
    python scripts/import_datajson.py <ai-log 根目录>
    # 例：python scripts/import_datajson.py ~/Quick/AI_log
"""
import os
import re
import sys
import json

# 让脚本能 import backend.app 与 packages
_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(_ROOT, "packages"))
sys.path.insert(0, os.path.join(_ROOT, "backend"))

from sqlalchemy import text  # noqa: E402
from app.db import SessionLocal, init_db  # noqa: E402
from app import repo  # noqa: E402
from ailog_core.schema import Entry  # noqa: E402

DEMO_USER_ID = 1


def ensure_demo_user(db):
    """确保 id=1 的演示用户存在（M1 临时；M2 起走真实注册）。"""
    row = db.execute(text("SELECT id FROM users WHERE id = :id"), {"id": DEMO_USER_ID}).fetchone()
    if row:
        return
    db.execute(text(
        "INSERT INTO users (id, email, password_hash, handle, is_admin, created_at) "
        "VALUES (:id, :email, :ph, :handle, 1, datetime('now'))"
    ), {"id": DEMO_USER_ID, "email": "demo@ailogy.local", "ph": "!", "handle": "demo"})
    db.commit()
    print(f"已建演示用户 id={DEMO_USER_ID} handle=demo")


def import_root(root):
    init_db()
    db = SessionLocal()
    try:
        ensure_demo_user(db)
        days = sorted(n for n in os.listdir(root)
                      if re.fullmatch(r"\d{4}-\d{2}-\d{2}", n))
        total = 0
        for day in days:
            data_path = os.path.join(root, day, "data.json")
            if not os.path.exists(data_path):
                continue
            with open(data_path, encoding="utf-8") as f:
                payload = json.load(f)
            for raw in payload.get("entries", []):
                e = Entry(**raw)
                repo.upsert_entry(db, DEMO_USER_ID, e)
                total += 1
            print(f"  {day}: {len(payload.get('entries', []))} 条")
        db.commit()
        print(f"✅ 共导入/更新 {total} 条到用户 {DEMO_USER_ID}")
    finally:
        db.close()


if __name__ == "__main__":
    if len(sys.argv) != 2:
        print(__doc__)
        sys.exit(1)
    root = os.path.expanduser(sys.argv[1])
    if not os.path.isdir(root):
        print(f"❌ 目录不存在：{root}")
        sys.exit(1)
    import_root(root)
