#!/usr/bin/env bash
# 用**官方 hurl 测试套件**验证本实现的规范兼容性。
#
# 这不是自测自过：测试文件来自 RealWorld 官方仓库
#   https://github.com/realworld-apps/realworld/tree/main/specs/api/hurl
# 存放在 conduit/specs-hurl/，本脚本只负责「起干净实例 → 跑官方套件 → 报告」。
#
# 用法：
#   ./conduit/run-hurl-tests.sh            # 跑全部 13 个文件
#   ./conduit/run-hurl-tests.sh articles.hurl   # 只跑指定文件
set -uo pipefail
cd "$(dirname "$0")/.."

PORT=${PORT:-8110}
DB=${DB:-conduithurl}
PG_PORT=${PG_PORT:-55432}
PG_USER=${PG_USER:-mbp}
PG_PASSWORD=${PG_PASSWORD:-mbp}
HURL=${HURL:-tools/hurl/hurl.exe}
[ -f "$HURL" ] || HURL=tools/hurl/hurl

if [ ! -f "$HURL" ]; then
  echo "找不到 hurl。请先下载：" >&2
  echo "  curl -sSL -o tools/hurl.zip https://github.com/Orange-OpenSource/hurl/releases/download/8.0.1/hurl-8.0.1-x86_64-pc-windows-msvc.zip" >&2
  echo "  powershell -Command \"Expand-Archive tools/hurl.zip -DestinationPath tools/hurl -Force\"" >&2
  exit 1
fi

BIN=_build/native/release/build/conduit/cmd/main/main.exe
[ -f "$BIN" ] || BIN=_build/native/debug/build/conduit/cmd/main/main.exe
if [ ! -f "$BIN" ]; then
  echo "找不到二进制，请先：moon build --target native --release" >&2
  exit 1
fi

# 官方套件之间有状态耦合（先建文章、后验证列表计数…），
# 因此每次都用**全新空库**，否则后跑的文件会被前面的数据污染。
echo "[1/4] 准备干净的数据库 $DB"
docker exec mbp-pg psql -U "$PG_USER" -d postgres \
  -c "DROP DATABASE IF EXISTS $DB;" >/dev/null 2>&1
docker exec mbp-pg psql -U "$PG_USER" -d postgres \
  -c "CREATE DATABASE $DB OWNER $PG_USER;" >/dev/null 2>&1 || {
  echo "创建数据库失败，请确认 mbp-pg 容器在运行" >&2; exit 1; }

echo "[2/4] 启动实例 :$PORT（库 $DB）"
# 实例会锁住 exe，构建前必须先停
if command -v taskkill >/dev/null 2>&1; then taskkill //F //IM main.exe >/dev/null 2>&1; else pkill -f 'build/conduit/cmd/main/main' >/dev/null 2>&1; fi
sleep 2
mkdir -p logs
MBP_HOST=127.0.0.1 MBP_PORT="$PORT" \
MBP_PG_HOST=127.0.0.1 MBP_PG_PORT="$PG_PORT" \
MBP_PG_USER="$PG_USER" MBP_PG_PASSWORD="$PG_PASSWORD" MBP_PG_DB="$DB" \
MBP_REDIS_HOST=127.0.0.1 MBP_REDIS_PORT=6379 \
MBP_RATE_LIMIT=100000 MBP_TRUST_PROXY=1 MBP_JWT_SECRET=hurl-test-secret \
MBP_CORS_ORIGINS=https://app.example.com MBP_BCRYPT_COST=6 MBP_MAX_CONNECTIONS=64 \
  nohup "$BIN" > "logs/hurl-$PORT.log" 2>&1 &

for i in $(seq 1 40); do
  sleep 1
  [ "$(curl -s -m 2 -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/health" 2>/dev/null)" = "200" ] && break
done
if [ "$(curl -s -m 2 -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/health" 2>/dev/null)" != "200" ]; then
  echo "实例未就绪，见 logs/hurl-$PORT.log" >&2; exit 1
fi
echo "      就绪"

echo "[3/4] 运行官方 hurl 套件"
FILES=("$@")
if [ ${#FILES[@]} -eq 0 ]; then
  FILES=(conduit/specs-hurl/*.hurl)
fi
UID_VAL="$(date +%s)$$"
"$HURL" --test --jobs 1 \
  --variable "host=http://127.0.0.1:$PORT" \
  --variable "uid=$UID_VAL" \
  "${FILES[@]}"
RC=$?

echo "[4/4] 结果：exit=$RC（0 表示全部通过）"
exit $RC
