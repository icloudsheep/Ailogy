#!/usr/bin/env bash
# Ailogy 启动脚本：用户只需 ./run.sh（可选 --reload 开发热重载）。
# PYTHONPATH 由本脚本设置（解释器启动前必须就位，故无法放进 .env）；
# 其余配置（DB / HOST / PORT / CORS 等）从仓库根 .env 读取，缺失则从 .env.example 复制。
set -euo pipefail

cd "$(dirname "$0")"

# 首次运行自动从模板生成 .env（.env 不入库）
if [ ! -f .env ]; then
  cp .env.example .env
  echo "ℹ️ 已从 .env.example 生成 .env，可按需编辑后重跑。"
fi

# venv 优先；没有则提示
PY=".venv/bin/python"
if [ ! -x "$PY" ]; then
  echo "❌ 未找到 .venv，请先：python3 -m venv .venv && .venv/bin/pip install -e ." >&2
  exit 1
fi

# 让 Python 能 import 到 backend(app) 与 packages(ailog_core)
export PYTHONPATH="packages:backend"

# 从 .env 读取 HOST/PORT（仅取这两项给 uvicorn 命令行用；其余配置由 app 内 settings 读）
HOST=$(grep -E '^AILOGY_HOST=' .env | tail -1 | cut -d= -f2-); HOST=${HOST:-127.0.0.1}
PORT=$(grep -E '^AILOGY_PORT=' .env | tail -1 | cut -d= -f2-); PORT=${PORT:-8000}

# 透传额外参数（如 --reload）
echo "🚀 Ailogy 启动于 http://$HOST:$PORT  （账户 /account · 密钥 /platform · 设置 /settings · 关于 /about）"
exec "$PY" -m uvicorn app.main:app --host "$HOST" --port "$PORT" "$@"
