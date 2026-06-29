"""时间 / duration / 跨午夜天数计算（纯函数，无 I/O）。

从原 store.py 抽出。CLI 写条目与后端 ingest 入库时都用同一套时间口径，
避免「本地算的 duration / day 和后端算的不一致」。
"""
from datetime import datetime

DATE_FMT = "%Y-%m-%d"
TIME_FMT = "%H:%M:%S"


def secs_between(start, end, cross_days=0):
    """HH:MM:SS 之间的秒差；cross_days 为跨越的天数（end 比 start 晚多少天）。

    同日且 end 早于 start 时按 0 计；跨日时把 cross_days*86400 计入，
    用于「上一条落在前一天、本条接续到今天」的真实时长。
    """
    fmt = lambda t: sum(int(x) * f for x, f in zip(t.split(":"), (3600, 60, 1)))
    return max(0, fmt(end) - fmt(start) + cross_days * 86400)


def days_between(date_a, date_b):
    """两个 YYYY-MM-DD 之间相差的天数（date_b - date_a），解析失败返回 0。"""
    try:
        da = datetime.strptime(date_a, DATE_FMT)
        db = datetime.strptime(date_b, DATE_FMT)
        return (db - da).days
    except ValueError:
        return 0
