#!/usr/bin/env bash
# 启动本机多实例 Conduit（默认 3 个实例，端口 8101/8102/8103）
# 配合 deploy/nginx.conf 的 upstream 做负载均衡。
set -euo pipefail
cd "$(dirname "$0")/.."

BIN=_build/native/release/build/conduit/cmd/main/main.exe
[ -f "$BIN" ] || BIN=_build/native/debug/build/conduit/cmd/main/main.exe
if [ ! -f "$BIN" ]; then
  echo "找不到二进制，请先运行：moon build --target native --release" >&2
  exit 1
fi

mkdir -p logs

export MBP_HOST=${MBP_HOST:-0.0.0.0}
export MBP_PG_HOST=${MBP_PG_HOST:-127.0.0.1}
export MBP_PG_PORT=${MBP_PG_PORT:-55432}
export MBP_PG_USER=${MBP_PG_USER:-mbp}
export MBP_PG_PASSWORD=${MBP_PG_PASSWORD:-mbp}
export MBP_PG_DB=${MBP_PG_DB:-conduitdb}
export MBP_REDIS_HOST=${MBP_REDIS_HOST:-127.0.0.1}
export MBP_REDIS_PORT=${MBP_REDIS_PORT:-6379}
export MBP_RATE_LIMIT=${MBP_RATE_LIMIT:-1000}
# 位于 nginx 之后 → 按 X-Forwarded-For 限流
export MBP_TRUST_PROXY=${MBP_TRUST_PROXY:-1}

if [ -z "${MBP_JWT_SECRET:-}" ]; then
  echo "警告：未设置 MBP_JWT_SECRET，将使用开发默认密钥（生产环境务必设置）" >&2
  export MBP_JWT_SECRET=conduit-dev-secret-change-me
fi

PORTS=${PORTS:-"8101 8102 8103"}
for p in $PORTS; do
  MBP_PORT="$p" nohup "$BIN" > "logs/instance-$p.log" 2>&1 &
  echo "已启动实例 :$p (pid $!)  日志 logs/instance-$p.log"
done

echo ""
echo "等待就绪..."
for p in $PORTS; do
  for _ in $(seq 1 30); do
    sleep 1
    if [ "$(curl -s -m 2 -o /dev/null -w '%{http_code}' "http://127.0.0.1:$p/health" 2>/dev/null)" = "200" ]; then
      echo "  :$p 就绪"
      break
    fi
  done
done
