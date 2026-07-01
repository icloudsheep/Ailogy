"""测试夹具：在任何 app 模块导入前，把 AILOGY_DB 指向临时库，避免污染真实库。"""
import os
import sys
import tempfile

import pytest

_fd, _path = tempfile.mkstemp(suffix="_test.db")
os.close(_fd)
os.environ["AILOGY_DB"] = _path

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "packages"))
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "backend"))
