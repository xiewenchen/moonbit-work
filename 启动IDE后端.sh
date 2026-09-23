#!/usr/bin/env bash
# 一键启动「MoonBit 写的 IDE 后端」（对应手册 6.3 / 0.1-0.4）
#
# 做的事：
#   1. 把 MoonBit 源码编译到 JS（ide-backend/cmd/main）
#   2. 用 node 把这个 JS 跑起来，暴露 JSON-RPC 服务
#   3. 顺带把预置的 demo 服务也拉起来（ide-backend/demo，端口 8099）
#
# 与手册 start.sh 的对应关系：
#   手册：moon build --target js  →  node target/js/.../main.js  →  npx vite
#   这里：moon build ... --target js  →  node _build/js/.../main.js --serve
#          （没有 vite 那一步：我们的前端是 Electron 窗口，不是浏览器页面）
set -uo pipefail
cd "$(dirname "$0")"

export PATH="$HOME/.moon/bin:$PATH"

PORT=${PORT:-8088}
DEMO_PORT=${DEMO_PORT:-8099}
MAIN_JS=_build/js/debug/build/ide-backend/cmd/main/main.js
DEMO_JS=_build/js/debug/build/ide-backend/demo/demo.js

echo "=============================================================="
echo " MoonBit IDE 后端（编译到 JS，跑在 Node 上）"
echo "=============================================================="

echo ""
echo "[1/3] 编译到 JS"
moon build ide-backend/cmd/main --target js 2>&1 | tail -3
moon build ide-backend/demo --target js 2>&1 | tail -3
if [ ! -f "$MAIN_JS" ]; then
  echo "  ✗ 编译产物缺失：$MAIN_JS" >&2
  exit 1
fi
echo "  ✓ 产物：$MAIN_JS"

echo ""
echo "[2/3] 自检（FFI 调 Node + JSON-RPC 分发）"
node "$MAIN_JS" 2>&1 | sed 's/^/  /'

echo ""
echo "[3/3] 启动服务"
echo "  JSON-RPC  → http://127.0.0.1:$PORT"
echo "  demo 服务 → http://127.0.0.1:$DEMO_PORT/api/hello"
echo ""
echo "  验证示例："
echo "    curl -s -X POST http://127.0.0.1:$PORT/ -d '{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"ping\"}'"
echo "    curl -s http://127.0.0.1:$DEMO_PORT/api/sum?a=3\\&b=4"
echo ""
echo "  按 Ctrl+C 结束。"
echo "=============================================================="

# 两个服务一起跑；任一退出就整体退出
node "$MAIN_JS" --serve "$PORT" &
RPC_PID=$!
if [ -f "$DEMO_JS" ]; then
  node "$DEMO_JS" &
  DEMO_PID=$!
fi

trap 'kill $RPC_PID ${DEMO_PID:-} 2>/dev/null' INT TERM
wait
