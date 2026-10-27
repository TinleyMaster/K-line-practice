#!/usr/bin/env bash
# K线刻意练习平台 —— 生产启动脚本
# 用法: ./deploy/start.sh [--setup]
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$APP_DIR"

echo "==> 项目目录: $APP_DIR"

if [ ! -f .env ]; then
  echo "!! 缺少 .env，请先执行: cp .env.example .env 并填入 DATABASE_URL" >&2
  exit 1
fi

if [ ! -d node_modules ]; then
  echo "==> 安装依赖"
  npm ci --omit=dev --workspaces --include-workspace-root
fi

if [ ! -d web/dist ]; then
  echo "==> 构建前端"
  npm run build
fi

if [ "${1:-}" = "--setup" ]; then
  echo "==> 初始化数据库"
  npm run db:init
  npm run db:seed
  echo "==> 物化 K 线（首次约 1~3 分钟）"
  npm run db:materialize
fi

echo "==> 启动服务"
exec node server/src/index.js
