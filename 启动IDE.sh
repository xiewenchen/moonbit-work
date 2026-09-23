#!/usr/bin/env bash
# 一键启动 MoonBit IDE（Electron 桌面壳）
#
# 打开后：
#   1. 底部面板切到「后端」标签
#   2. 点「▶ 启动后端」→ 日志区会显示启动过程，状态徽章变绿
#   3. 后端就跑在 http://127.0.0.1:8110
set -euo pipefail
cd "$(dirname "$0")/desktop"

echo "检查依赖容器…"
for c in mbp-pg mbp-redis; do
  if docker ps --format '{{.Names}}' 2>/dev/null | grep -q "^${c}$"; then
    echo "  [OK] $c 在运行"
  else
    echo "  [WARN] $c 未运行 —— IDE 里点启动时会提示"
  fi
done

echo ""
echo "启动 IDE…（关闭窗口即退出）"
npm start
