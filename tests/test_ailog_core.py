"""ailog_core.schema 单测：后端入库校验用的 entry 契约。

会话代号 / 时间计算等客户端逻辑已迁至 ai-log skill，本仓库只保留 entry 形状校验。
"""
import sys
import os

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "packages"))

from ailog_core.schema import Entry, Usage, Carryover, day_of


# ── entry schema ──
def test_entry_minimal():
    e = Entry(seq=1, id="Fox-3f2a", datetime="2026-06-29 10:00:00")
    assert e.title == "" and e.usage is None and e.carryover is None


def test_entry_full():
    e = Entry(
        seq=2, id="Wolf-aa11", emoji="🐺", name="Wolf", title="标题",
        datetime="2026-06-29 11:22:33", duration=120, summary="正文",
        mode="full",
        carryover=Carryover(prev_date="2026-06-28", prev_end="23:50:00"),
        usage=Usage(input=100, output=50, turns=3),
    )
    assert e.usage.input == 100 and e.usage.turns == 3
    assert e.carryover.prev_date == "2026-06-28"
    assert e.mode == "full"


def test_entry_extra_ignored():
    # 上报体可能多带字段，应忽略而非报错
    e = Entry(seq=1, id="X-0000", datetime="2026-06-29 00:00:00", unknown_field=123)
    assert not hasattr(e, "unknown_field")


def test_day_of():
    assert day_of("2026-06-29 10:00:00") == "2026-06-29"
    assert day_of("") == ""
