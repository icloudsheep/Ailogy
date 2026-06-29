"""测试夹具：在任何 app 模块导入前，把 AILOGY_DB 指向临时库，避免污染真实库。"""
import os
import tempfile

# 进程级一次性设定：测试统一用一个临时库文件
_fd, _path = tempfile.mkstemp(suffix="_test.db")
os.close(_fd)
os.environ["AILOGY_DB"] = _path
