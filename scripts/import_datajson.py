#!/usr/bin/env python3
"""把现有 ai-log 的 data.json（按天目录）一次性导入 Ailogy 数据库。

用法：
    python scripts/import_datajson.py <ai-log 根目录> [设备名]
    # 设备名省略则用本机主机名
"""
import os
import re
import sys
import json
import socket

_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(_ROOT, "packages"))
sys.path.insert(0, os.path.join(_ROOT, "backend"))

from app.db import SessionLocal, init_db  # noqa: E402
from app import repo  # noqa: E402
from ailog_core.schema import Entry  # noqa: E402


def import_root(root, device):
    init_db()
    db = SessionLocal()
    try:
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
                raw.setdefault("device", device)  # 未带设备名则补默认
                e = Entry(**raw)
                repo.upsert_entry(db, e)
                total += 1
            print(f"  {day}: {len(payload.get('entries', []))} 条")
        db.commit()
        print(f"✅ 共导入/更新 {total} 条（设备 {device}）")
    finally:
        db.close()


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(1)
    root = os.path.expanduser(sys.argv[1])
    device = sys.argv[2] if len(sys.argv) > 2 else (socket.gethostname() or "unknown").split(".")[0]
    if not os.path.isdir(root):
        print(f"❌ 目录不存在：{root}")
        sys.exit(1)
    import_root(root, device)
