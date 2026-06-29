"""集中配置：从仓库根 .env 读取，避免散落的 os.environ 与硬编码。

.env 不入库（见 .gitignore），占位模板见 .env.example。
所有可调项（DB 路径、CORS、端口、版本/仓库）都经此模块，减少硬编码。
"""
import os

from dotenv import load_dotenv

_REPO_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

# 加载仓库根 .env（不存在则静默跳过，仍可用真实环境变量兜底）
load_dotenv(os.path.join(_REPO_ROOT, ".env"))


def _get(key, default=""):
    return os.environ.get(key, default)


# 数据库文件路径
DB_PATH = _get("AILOGY_DB") or os.path.join(_REPO_ROOT, "ailogy.db")
# 监听地址 / 端口（供 run.sh 等启动脚本读取）
HOST = _get("AILOGY_HOST", "127.0.0.1")
PORT = int(_get("AILOGY_PORT", "8000"))
# CORS 允许来源（逗号分隔）
CORS_ORIGINS = [o.strip() for o in _get(
    "AILOGY_CORS_ORIGINS", "http://localhost:8000,http://127.0.0.1:8000").split(",") if o.strip()]
# 会话 cookie 是否 Secure（上线 https 置 1）
COOKIE_SECURE = _get("AILOGY_COOKIE_SECURE", "0") in ("1", "true", "yes")
# 版本与仓库（关于页 / /api/version）
VERSION = _get("AILOGY_VERSION", "0.1.0")
REPO = _get("AILOGY_REPO", "https://github.com/icloudsheep/Ailogy")
