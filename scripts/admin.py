#!/usr/bin/env python3
"""管理员 CLI：审批密钥申请、提升管理员。

用法：
    python scripts/admin.py list                      # 列待审申请
    python scripts/admin.py review                    # 交互式逐条审批（推荐）
    python scripts/admin.py approve <申请id> [备注]    # 批准并打印明文密钥
    python scripts/admin.py reject  <申请id> <理由>    # 拒绝（理由必填）
    python scripts/admin.py make-admin <邮箱>          # 把某用户提为管理员
"""
import os
import sys
from datetime import datetime

_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(_ROOT, "packages"))
sys.path.insert(0, os.path.join(_ROOT, "backend"))

from app.db import SessionLocal, init_db  # noqa: E402
from app import models  # noqa: E402
from app.security import new_api_key  # noqa: E402


def cmd_list(db):
    rows = db.query(models.KeyApplication).filter(
        models.KeyApplication.status == "pending").order_by(
        models.KeyApplication.created_at.asc()).all()
    if not rows:
        print("（无待审申请）"); return
    for a in rows:
        u = db.get(models.User, a.user_id)
        print(f"#{a.id}  用户={u.email if u else a.user_id}  理由={a.reason!r}  时间={a.created_at}")


def cmd_approve(db, app_id, note=""):
    a = db.get(models.KeyApplication, int(app_id))
    if not a or a.status != "pending":
        print("❌ 申请不存在或非 pending"); return
    plain, prefix, key_hash = new_api_key()
    a.status = "approved"; a.review_note = note; a.reviewed_at = datetime.utcnow()
    db.add(models.ApiKey(user_id=a.user_id, prefix=prefix, key_hash=key_hash,
                         secret=plain, label="审批发放"))
    db.commit()
    print(f"✅ 已批准申请 #{app_id}")
    print(f"   明文密钥（请转交用户；也可在该用户密钥页随时复制）：{plain}")


def cmd_review(db):
    """交互式：列出全部待审申请，逐条询问 批准/拒绝/跳过。"""
    rows = db.query(models.KeyApplication).filter(
        models.KeyApplication.status == "pending").order_by(
        models.KeyApplication.created_at.asc()).all()
    if not rows:
        print("（无待审申请）"); return
    print(f"共 {len(rows)} 条待审申请：\n")
    for a in rows:
        u = db.get(models.User, a.user_id)
        print(f"#{a.id}  用户={u.email if u else a.user_id}  理由={a.reason!r}  时间={a.created_at}")
        choice = input("  [a]批准 / [r]拒绝 / [s]跳过（默认跳过）> ").strip().lower()
        if choice == "a":
            cmd_approve(db, a.id, "交互审批通过")
        elif choice == "r":
            note = input("  拒绝理由：").strip()
            if note:
                cmd_reject(db, a.id, note)
            else:
                print("  未填理由，跳过")
        else:
            print("  已跳过")
        print()


def cmd_reject(db, app_id, *reason):
    note = " ".join(reason).strip()
    if not note:
        print("❌ 拒绝必须填理由"); return
    a = db.get(models.KeyApplication, int(app_id))
    if not a or a.status != "pending":
        print("❌ 申请不存在或非 pending"); return
    a.status = "rejected"; a.review_note = note; a.reviewed_at = datetime.utcnow()
    db.commit()
    print(f"✅ 已拒绝申请 #{app_id}：{note}")


def cmd_make_admin(db, email):
    u = db.query(models.User).filter(models.User.email == email).first()
    if not u:
        print(f"❌ 用户不存在：{email}"); return
    u.is_admin = True; db.commit()
    print(f"✅ {email} 已设为管理员")


def main():
    if len(sys.argv) < 2:
        print(__doc__); sys.exit(1)
    init_db()
    db = SessionLocal()
    try:
        cmd, args = sys.argv[1], sys.argv[2:]
        fn = {"list": cmd_list, "review": cmd_review, "approve": cmd_approve,
              "reject": cmd_reject, "make-admin": cmd_make_admin}.get(cmd)
        if not fn:
            print(__doc__); sys.exit(1)
        fn(db, *args)
    finally:
        db.close()


if __name__ == "__main__":
    main()
