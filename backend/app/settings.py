"""集中配置：从仓库根 .env 读取。

.env 不入库（见 .gitignore），占位模板见 .env.example。
所有可调项（DB 路径、端口、版本/仓库）都经此模块。
"""
import os

from dotenv import load_dotenv

_REPO_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

load_dotenv(os.path.join(_REPO_ROOT, ".env"))


def _get(key, default=""):
    return os.environ.get(key, default)


DB_PATH = _get("AILOGY_DB") or os.path.join(_REPO_ROOT, "ailogy.db")
HOST = _get("AILOGY_HOST", "127.0.0.1")
PORT = int(_get("AILOGY_PORT", "8000"))


def _read_version_file():
    """从仓库根的 VERSION 文件读版本号；文件不存在或为空则回退到默认。
    优先级：env AILOGY_VERSION > VERSION 文件 > 默认字符串。"""
    try:
        p = os.path.join(_REPO_ROOT, "VERSION")
        with open(p, "r", encoding="utf-8") as f:
            v = f.read().strip()
            return v or "0.1.0"
    except Exception:
        return "0.1.0"


VERSION = (_get("AILOGY_VERSION") or "").strip() or _read_version_file()
REPO = _get("AILOGY_REPO", "https://github.com/icloudsheep/Ailogy")
