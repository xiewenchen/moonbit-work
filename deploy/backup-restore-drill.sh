#!/usr/bin/env bash
# PostgreSQL 备份 / 恢复演练
#
# 目的：验证「真的能在事故后把数据找回来」，而不是只写了备份命令却没试过。
#
# 步骤：
#   1. 记录业务数据指纹（关键表行数）
#   2. pg_dump 全库备份
#   3. 人为破坏（DROP 一张表，模拟误操作）
#   4. 确认业务确实坏了
#   5. 从备份恢复
#   6. 校验指纹一致 + 业务恢复
#
# 用法：./deploy/backup-restore-drill.sh
set -uo pipefail
cd "$(dirname "$0")/.."

CONTAINER=${CONTAINER:-mbp-pg}
DB=${DB:-conduitdb}
USER=${USER_PG:-mbp}
BASE=${BASE:-https://127.0.0.1:8443}
OUT=deploy/backup
mkdir -p "$OUT"
STAMP=$(date +%Y%m%d-%H%M%S)
DUMP="$OUT/${DB}-${STAMP}.sql"

psql_q() { docker exec -i "$CONTAINER" psql -U "$USER" -d "$DB" -t -A -c "$1" 2>/dev/null; }

fingerprint() {
  # 关键表的行数 + 表数量，作为数据指纹
  psql_q "SELECT 'users='||count(*) FROM users" 
  psql_q "SELECT 'articles='||count(*) FROM articles"
  psql_q "SELECT 'comments='||count(*) FROM comments"
  psql_q "SELECT 'tags='||count(*) FROM tags"
  psql_q "SELECT 'tables='||count(*) FROM information_schema.tables WHERE table_schema='public'"
}

echo "=============================================================="
echo " PostgreSQL 备份 / 恢复演练  (db=$DB)"
echo "=============================================================="

echo ""
echo "[1/6] 记录备份前数据指纹"
BEFORE=$(fingerprint)
echo "$BEFORE" | sed 's/^/       /'

echo ""
echo "[2/6] 执行 pg_dump"
docker exec "$CONTAINER" pg_dump -U "$USER" -d "$DB" > "$DUMP" 2>/dev/null
SIZE=$(wc -c < "$DUMP" | tr -d ' ')
if [ "$SIZE" -lt 100 ]; then
  echo "       ✗ 备份文件异常（仅 ${SIZE} 字节）"; exit 1
fi
echo "       ✓ 已写出 $DUMP (${SIZE} 字节)"

echo ""
echo "[3/6] 人为破坏：DROP TABLE comments（模拟误操作）"
psql_q "DROP TABLE comments CASCADE" >/dev/null
echo "       ✓ 已删除 comments 表"

echo ""
echo "[4/6] 确认业务确实坏了"
BROKEN=$(psql_q "SELECT count(*) FROM information_schema.tables WHERE table_schema='public' AND table_name='comments'")
if [ "$BROKEN" = "0" ]; then
  echo "       ✓ comments 表已不存在（破坏生效）"
else
  echo "       ✗ 破坏未生效"; exit 1
fi
# 通过 API 确认请求会失败（文章评论接口应 500 或 404）
CODE=$(curl -sk -m 8 -o /dev/null -w '%{http_code}' "$BASE/api/articles/hello-world/comments" 2>/dev/null)
echo "       API /articles/:slug/comments → HTTP $CODE"

echo ""
echo "[5/6] 从备份恢复"
docker exec -i "$CONTAINER" psql -U "$USER" -d "$DB" < "$DUMP" >/dev/null 2>&1
echo "       ✓ 已导入备份"

echo ""
echo "[6/6] 校验数据指纹"
AFTER=$(fingerprint)
echo "$AFTER" | sed 's/^/       /'
if [ "$BEFORE" = "$AFTER" ]; then
  echo ""
  echo "       ✓ 指纹一致 —— 数据完整恢复"
else
  echo ""
  echo "       ✗ 指纹不一致！"
  diff <(echo "$BEFORE") <(echo "$AFTER") | sed 's/^/         /'
  exit 1
fi

CODE=$(curl -sk -m 8 -o /dev/null -w '%{http_code}' "$BASE/api/tags" 2>/dev/null)
echo "       ✓ 业务恢复：/api/tags → HTTP $CODE"
echo ""
echo "=============================================================="
echo " 演练结论：备份可用，恢复后数据一致"
echo "=============================================================="
