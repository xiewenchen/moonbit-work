#!/usr/bin/env bash
# 停止本机全部 Conduit 实例
set -uo pipefail
if command -v taskkill >/dev/null 2>&1; then
  taskkill //F //IM main.exe 2>/dev/null || echo "没有正在运行的实例"
else
  pkill -f "build/conduit/cmd/main/main" || echo "没有正在运行的实例"
fi
