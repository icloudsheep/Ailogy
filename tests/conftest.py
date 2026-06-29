"""测试夹具：在任何 app 模块导入前，把 AILOGY_DB 指向临时库，避免污染真实库。"""
import os
import sys
import tempfile

import pytest

# 进程级一次性设定：测试统一用一个临时库文件
_fd, _path = tempfile.mkstemp(suffix="_test.db")
os.close(_fd)
os.environ["AILOGY_DB"] = _path

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "packages"))
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "backend"))


@pytest.fixture(autouse=True)
def _reset_ratelimit():
    """每个测试前清空限流计数——多数测试会多次登录/注册，否则会误触发限流。"""
    from app import ratelimit
    ratelimit._hits.clear()
    yield
