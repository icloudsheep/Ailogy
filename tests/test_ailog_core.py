"""ailog_core 纯逻辑单测：会话代号、时间计算、entry schema。

这些是 CLI 与后端共用的单一事实源，必须确定性、与原 ai-log 行为一致。
"""
import sys
import os

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "packages"))

from ailog_core.session import session_codename, ANIMALS
from ailog_core.timecalc import secs_between, days_between
from ailog_core.schema import Entry, Usage, Carryover, day_of


# ── 会话代号：确定性派生 ──
def test_codename_deterministic():
    a = session_codename("session-abc")
    b = session_codename("session-abc")
    assert a == b  # 同 seed 恒定
    assert set(a) == {"emoji", "name", "suffix"}
    assert len(a["suffix"]) == 4


def test_codename_distinct():
    assert session_codename("x") != session_codename("y")


def test_codename_empty_seed():
    assert session_codename("") == {"emoji": "🐾", "name": "Anon", "suffix": "0000"}
    assert session_codename(None) == {"emoji": "🐾", "name": "Anon", "suffix": "0000"}


def test_codename_from_animals_table():
    cn = session_codename("whatever")
    assert (cn["emoji"], cn["name"]) in ANIMALS


# ── 时间计算 ──
def test_secs_between_basic():
    assert secs_between("00:00:00", "01:30:00") == 5400
    assert secs_between("10:00:00", "10:00:00") == 0


def test_secs_between_same_day_reversed_is_zero():
    # 同日 end 早于 start 按 0 计
    assert secs_between("12:00:00", "09:00:00") == 0


def test_secs_between_cross_days():
    # 跨 1 天：23:00 → 次日 01:00 = 2 小时
    assert secs_between("23:00:00", "01:00:00", cross_days=1) == 7200


def test_days_between():
    assert days_between("2026-06-24", "2026-06-29") == 5
    assert days_between("2026-06-29", "2026-06-24") == -5
    assert days_between("bad", "2026-06-29") == 0  # 解析失败回退 0


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
