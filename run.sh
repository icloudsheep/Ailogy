#!/usr/bin/env bash
# Ailogy 启动脚本：用户只需 ./run.sh（可选 --reload 开发热重载）。
# PYTHONPATH 由本脚本设置；其余配置从仓库根 .env 读取，缺失则从 .env.example 复制。
set -euo pipefail

cd "$(dirname "$0")"

if [ ! -f .env ]; then
  cp .env.example .env
  echo "ℹ️ 已从 .env.example 生成 .env，可按需编辑后重跑。"
fi

PY=".venv/bin/python"
if [ ! -x "$PY" ]; then
  echo "❌ 未找到 .venv，请先：python3 -m venv .venv && .venv/bin/pip install -e ." >&2
  exit 1
fi

export PYTHONPATH="packages:backend"

HOST=$(grep -E '^AILOGY_HOST=' .env | tail -1 | cut -d= -f2-); HOST=${HOST:-127.0.0.1}
PORT=$(grep -E '^AILOGY_PORT=' .env | tail -1 | cut -d= -f2-); PORT=${PORT:-8000}

echo "🚀 Ailogy 启动于 http://$HOST:$PORT"
exec "$PY" -m uvicorn app.main:app --host "$HOST" --port "$PORT" "$@"
