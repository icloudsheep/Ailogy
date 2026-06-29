"""git 分支读取与日志条目写入 / 编辑 / 删除。

写入聚合多个模块：会话代号（session）、时间线与跨午夜（store）、
token 统计（transcript）、最终落盘与渲染（render）。
"""
import json
import os
import subprocess
from datetime import datetime

from . import render
from ailog_core.session import session_codename
from ailog_core.transcript import usage_since
from .store import (
    DATE_FMT, TIME_FMT, load_day, last_end_of_session,
    find_prev_day_with_session, days_between, secs_between, _prev_entry_datetime,
)


def git_branch(cwd):
    """安全读取 cwd 所在仓库的当前分支名；非仓库 / 出错时返回空串。"""
    try:
        out = subprocess.run(
            ["git", "rev-parse", "--abbrev-ref", "HEAD"],
            cwd=cwd, capture_output=True, text=True, timeout=2,
        )
        return out.stdout.strip() if out.returncode == 0 else ""
    except Exception:
        return ""


def write_entry(root, summary, title, id_override, mode=None):
    """把一条日志写入 <root>/{date}/ 下的 data.json，并刷新 index.html。

    返回 (会话代号字典, 会话 id, index.html 路径)，供调用方回显。
    跨午夜接续：本会话当天无记录、但更早日期里有，则起点继承昨日结束时间、
    时长按真实跨日计算，并写入 carryover 元信息供 UI 标注「前一部分在上一日」。
    """
    cn = session_codename(os.environ.get("CLAUDE_CODE_SESSION_ID"))
    if id_override:
        cn = {"emoji": "🔖", "name": id_override, "suffix": "0000"}
    codename_id = f"{cn['name']}-{cn['suffix']}"

    now = datetime.now()
    date_str = now.strftime(DATE_FMT)
    end_time = now.strftime(TIME_FMT)

    day_dir = os.path.join(root, date_str)
    os.makedirs(day_dir, exist_ok=True)
    data_path = os.path.join(day_dir, "data.json")
    html_path = os.path.join(day_dir, "index.html")

    day = load_day(data_path)
    day["date"] = date_str

    # 起点解析：优先继承「本会话」当天上一条的结束时间（同日，cross_days=0）
    start_time = last_end_of_session(day["entries"], codename_id)
    cross_days = 0
    carryover = None
    if start_time is None:
        # 当天本会话无记录 → 看更早日期是否有本会话尾巴（跨午夜接续）
        prev_date, prev_end = find_prev_day_with_session(root, date_str, codename_id)
        if prev_end is not None:
            start_time = prev_end
            cross_days = days_between(prev_date, date_str)
            carryover = {"prev_date": prev_date, "prev_end": prev_end}
        else:
            start_time = end_time  # 全新会话首条：0 时长起点

    cwd = os.getcwd()
    entry = {
        "seq": len(day["entries"]) + 1,           # 当天全局序号（记录顺序）
        "id": codename_id,
        "emoji": cn["emoji"],
        "name": cn["name"],
        "title": (title or "").strip(),
        "start": start_time,
        "end": end_time,
        "datetime": now.strftime("%Y-%m-%d %H:%M:%S"),
        "duration": secs_between(start_time, end_time, cross_days),  # 本条耗时（秒，含跨日）
        "cwd": cwd,
        "project": os.path.basename(cwd.rstrip("/")) or cwd,
        "branch": git_branch(cwd),
        "model": os.environ.get("ANTHROPIC_MODEL", ""),
        "summary": summary.strip(),
    }
    if carryover:
        entry["carryover"] = carryover  # 标注：本会话前一部分在 prev_date
    if mode:
        entry["mode"] = mode  # 记录模式，如 "full"（按主题总结），供 UI 加角标区分

    # 分段 token / 轮数：统计「本会话上一条记录之后」到现在的 transcript 增量
    prev_dt = _prev_entry_datetime(day["entries"], codename_id, root, date_str)
    stats = usage_since(os.environ.get("CLAUDE_CODE_SESSION_ID"), prev_dt, now)
    if stats:
        entry["usage"] = stats  # input/output/cache_read/cache_write/turns/api_calls

    day["entries"].append(entry)

    with open(data_path, "w", encoding="utf-8") as f:
        json.dump(day, f, ensure_ascii=False, indent=2)
    render.render_html(day, html_path, root)
    # 同时返回刚写入的 entry（供 CLI 双模式上报后端，无需再拼一次）
    return cn, codename_id, html_path, entry


def edit_entry(root, date_str, seq, new_title, new_summary):
    """永久编辑某条日志的标题/正文：改写 <root>/{date}/data.json 并重渲染该日 HTML。

    按 (date, seq) 定位条目（seq 为当天写入时固定的全局序号，稳定可用）。
    new_title / new_summary 为 None 时表示该字段不变；返回 True 表示命中并已写回。
    """
    data_path = os.path.join(root, date_str, "data.json")
    if not os.path.exists(data_path):
        return False
    with open(data_path, "r", encoding="utf-8") as f:
        day = json.load(f)
    hit = None
    for e in day.get("entries", []):
        if e.get("seq") == seq:
            hit = e
            break
    if hit is None:
        return False
    if new_title is not None:
        hit["title"] = new_title.strip()
    if new_summary is not None:
        hit["summary"] = new_summary.strip()
    with open(data_path, "w", encoding="utf-8") as f:
        json.dump(day, f, ensure_ascii=False, indent=2)
    render.render_html(day, os.path.join(root, date_str, "index.html"), root)
    return True


def delete_entry(root, date_str, seq):
    """永久删除某条日志：从 <root>/{date}/data.json 移除该 seq 条目并重渲染该日 HTML。

    保留其余条目的原 seq 不变（避免打乱 carryover / 本地覆盖层等按 seq 的定位）。
    返回 True 表示命中并已删除。
    """
    data_path = os.path.join(root, date_str, "data.json")
    if not os.path.exists(data_path):
        return False
    with open(data_path, "r", encoding="utf-8") as f:
        day = json.load(f)
    entries = day.get("entries", [])
    kept = [e for e in entries if e.get("seq") != seq]
    if len(kept) == len(entries):
        return False
    day["entries"] = kept
    with open(data_path, "w", encoding="utf-8") as f:
        json.dump(day, f, ensure_ascii=False, indent=2)
    render.render_html(day, os.path.join(root, date_str, "index.html"), root)
    return True
