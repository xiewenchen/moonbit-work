#!/usr/bin/env bash
# 一键拉起「Conduit 后端」完整环境，并做自检。
#
# 拉起的东西：
#   3 × Conduit 实例 (:8101/:8102/:8103)  ← 纯 MoonBit 实现的后端
#   nginx          :8443 (TLS 终止 + 负载均衡)  /  :8090 仅做 301 跳转
#   PostgreSQL     :55432 (独立库 conduitdb) + Redis :6379
#   Prometheus     :9090  (指标采集 + 10 条告警规则)
#   Alertmanager   :9093  (告警路由/分组/抑制 → webhook)
#   Grafana        :3000  (面板，数据源自动挂载)
#   Swagger UI     :8085  (交互式 API 文档)
#   告警接收端      :9099  (本机验证用，落盘 deploy/alert-receiver.log)
#
# 幂等：可重复执行。
set -uo pipefail
cd "$(dirname "$0")/.."

PG_PORT=${PG_PORT:-55432}
DB=${DB:-conduitdb}
PG_USER=${PG_USER:-mbp}
PG_PASSWORD=${PG_PASSWORD:-mbp}
PORTS=${PORTS:-"8101 8102 8103"}

ok()   { echo "  [OK]   $*"; }
warn() { echo "  [WARN] $*"; }
die()  { echo "  [FAIL] $*" >&2; exit 1; }

echo "=============================================================="
echo " Conduit 后端 —— 一键启动"
echo "=============================================================="

command -v docker >/dev/null || die "需要 docker"
mkdir -p logs deploy/backup

# ---------------------------------------------------------------- 依赖容器
echo ""
echo "[1] 依赖容器（PostgreSQL / Redis）"
if ! docker ps --format '{{.Names}}' | grep -q '^mbp-pg$'; then
  docker run -d --name mbp-pg -p "${PG_PORT}:5432" \
    -e POSTGRES_HOST_AUTH_METHOD=trust \
    -e POSTGRES_USER="$PG_USER" -e POSTGRES_PASSWORD="$PG_PASSWORD" \
    -e POSTGRES_DB=mbptest postgres:16-alpine >/dev/null 2>&1 \
    && ok "已创建 mbp-pg" || die "mbp-pg 启动失败"
  sleep 6
else ok "mbp-pg 已在运行"; fi

if ! docker ps --format '{{.Names}}' | grep -q '^mbp-redis$'; then
  docker run -d --name mbp-redis -p 6379:6379 redis:7-alpine >/dev/null 2>&1 \
    && ok "已创建 mbp-redis" || die "mbp-redis 启动失败"
else ok "mbp-redis 已在运行"; fi

# ---------------------------------------------------------------- 独立数据库
echo ""
echo "[2] 独立数据库（必须专用，避免与其它服务同名表冲突）"
if docker exec mbp-pg psql -U "$PG_USER" -lqt 2>/dev/null | cut -d'|' -f1 | grep -qw "$DB"; then
  ok "数据库 $DB 已存在"
else
  docker exec mbp-pg psql -U "$PG_USER" -d postgres -c "CREATE DATABASE $DB OWNER $PG_USER;" >/dev/null 2>&1 \
    && ok "已创建数据库 $DB" || die "创建 $DB 失败"
fi

# ---------------------------------------------------------------- 编译
echo ""
echo "[3] 编译 release 二进制"
# 运行中的实例会锁住 exe，必须先停；否则链接报 LNK1104/LNK1168
if command -v taskkill >/dev/null 2>&1; then taskkill //F //IM main.exe >/dev/null 2>&1; else pkill -f 'build/conduit/cmd/main/main' >/dev/null 2>&1; fi
sleep 1
export PATH="$HOME/.moon/bin:$PATH"
moon build --target native --release >/dev/null 2>&1 && ok "编译完成" || die "编译失败（先看 moon check）"
BIN=_build/native/release/build/conduit/cmd/main/main.exe
[ -f "$BIN" ] || BIN=_build/native/debug/build/conduit/cmd/main/main.exe
[ -f "$BIN" ] || die "找不到二进制"

# ---------------------------------------------------------------- 后端实例
echo ""
echo "[4] 启动后端实例（纯 MoonBit）"
export MBP_HOST=0.0.0.0
export MBP_PG_HOST=127.0.0.1 MBP_PG_PORT="$PG_PORT" MBP_PG_USER="$PG_USER" MBP_PG_PASSWORD="$PG_PASSWORD" MBP_PG_DB="$DB"
export MBP_REDIS_HOST=127.0.0.1 MBP_REDIS_PORT=6379
export MBP_JWT_SECRET=${MBP_JWT_SECRET:-conduit-dev-secret-change-me}
export MBP_JWT_TTL_SEC=604800
export MBP_CORS_ORIGINS=${MBP_CORS_ORIGINS:-https://app.example.com}
export MBP_BCRYPT_COST=6
export MBP_RATE_LIMIT=${MBP_RATE_LIMIT:-50}
export MBP_MAX_CONNECTIONS=64
# 位于 nginx 之后 → 按 X-Forwarded-For 限流
export MBP_TRUST_PROXY=1

for p in $PORTS; do
  MBP_PORT="$p" nohup "$BIN" > "logs/instance-$p.log" 2>&1 &
done
for p in $PORTS; do
  for _ in $(seq 1 30); do
    sleep 1
    [ "$(curl -s -m 2 -o /dev/null -w '%{http_code}' "http://127.0.0.1:$p/health" 2>/dev/null)" = "200" ] && break
  done
  [ "$(curl -s -m 2 -o /dev/null -w '%{http_code}' "http://127.0.0.1:$p/health" 2>/dev/null)" = "200" ] \
    && ok "实例 :$p 就绪" || warn "实例 :$p 未就绪（看 logs/instance-$p.log）"
done

# ---------------------------------------------------------------- 基础设施容器
WD=$(pwd -W 2>/dev/null || pwd)
ensure() { # name  image  run-args...
  local name=$1 image=$2; shift 2
  if docker ps --format '{{.Names}}' | grep -q "^${name}$"; then
    ok "$name 已在运行"
  else
    docker rm -f "$name" >/dev/null 2>&1
    # MSYS_NO_PATHCONV：防止 Git Bash 把容器内的 /path 转成 Windows 路径
    MSYS_NO_PATHCONV=1 docker run -d --name "$name" "$@" "$image" >/dev/null 2>&1 \
      && ok "已启动 $name" || warn "$name 启动失败"
  fi
}

echo ""
echo "[5] nginx（TLS 终止 + 负载均衡）"
if [ ! -f deploy/certs/server.crt ]; then
  mkdir -p deploy/certs
  MSYS_NO_PATHCONV=1 openssl req -x509 -newkey rsa:2048 -nodes \
    -keyout deploy/certs/server.key -out deploy/certs/server.crt \
    -days 365 -subj "/CN=localhost" \
    -addext "subjectAltName=DNS:localhost,IP:127.0.0.1" >/dev/null 2>&1 \
    && ok "已生成自签证书"
fi
ensure mbp-nginx nginx:alpine -p 8090:8090 -p 8443:8443 \
  -v "$WD/deploy/nginx.conf:/etc/nginx/nginx.conf:ro" \
  -v "$WD/deploy/certs:/etc/nginx/certs:ro"

echo ""
echo "[6] 可观测性（Prometheus / Alertmanager / Grafana）"
ensure mbp-prometheus prom/prometheus:latest -p 9090:9090 \
  -v "$WD/deploy/prometheus.yml:/etc/prometheus/prometheus.yml:ro" \
  -v "$WD/deploy/alerting_rules.yml:/etc/prometheus/alerting_rules.yml:ro"
ensure mbp-alertmanager prom/alertmanager:latest -p 9093:9093 \
  -v "$WD/deploy/alertmanager.yml:/etc/alertmanager/alertmanager.yml:ro"
ensure mbp-grafana grafana/grafana:latest -p 3000:3000 \
  -e GF_SECURITY_ADMIN_USER=admin -e GF_SECURITY_ADMIN_PASSWORD=admin \
  -e GF_USERS_ALLOW_SIGN_UP=false \
  -v "$WD/deploy/grafana/provisioning:/etc/grafana/provisioning:ro" \
  -v "$WD/deploy/grafana/dashboards:/etc/grafana/dashboards:ro"

echo ""
echo "[7] API 文档（Swagger UI）"
ensure mbp-swagger swaggerapi/swagger-ui:latest -p 8085:8080 \
  -e SWAGGER_JSON=/spec/openapi.yml \
  -v "$WD/conduit/openapi.yml:/spec/openapi.yml:ro"

echo ""
echo "[8] 告警接收端（本机验证用）"
if curl -s -m 2 -o /dev/null http://127.0.0.1:9099/webhook 2>/dev/null; then
  ok "接收端已在运行"
else
  nohup python deploy/alert-receiver.py > logs/alert-receiver.out 2>&1 &
  sleep 3
  ok "已启动接收端"
fi

# ---------------------------------------------------------------- 自检
echo ""
echo "=============================================================="
echo " 自检"
echo "=============================================================="
sleep 5
fail=0
check() { # 描述 url 期望码
  local desc=$1 url=$2 want=$3 extra=${4:-}
  local got
  got=$(curl -sk -m 8 -o /dev/null -w '%{http_code}' $extra "$url" 2>/dev/null)
  if [ "$got" = "$want" ]; then ok "$desc → $got"; else warn "$desc → $got（期望 $want）"; fail=$((fail+1)); fi
}
check "nginx HTTPS /health"        https://127.0.0.1:8443/health 200
check "nginx HTTPS /api/tags"      https://127.0.0.1:8443/api/tags 200
check "HTTP → HTTPS 跳转"          http://127.0.0.1:8090/api/tags 301
check "Prometheus 就绪"            http://127.0.0.1:9090/-/ready 200
check "Alertmanager 就绪"          http://127.0.0.1:9093/-/ready 200
check "Grafana 就绪"               http://127.0.0.1:3000/api/health 200
check "Swagger UI 就绪"            http://127.0.0.1:8085/ 200

up=$(curl -s -m 8 "http://127.0.0.1:9090/api/v1/targets?state=active" 2>/dev/null \
     | python -c "import json,sys;print(sum(1 for t in json.load(sys.stdin)['data']['activeTargets'] if t['health']=='up'))" 2>/dev/null)
echo "  [--]   Prometheus 抓取到的实例数: ${up:-?}/3"

echo ""
echo "=============================================================="
echo " 访问入口"
echo "=============================================================="
cat <<EOF
  API（经 TLS + 负载均衡）  https://127.0.0.1:8443/api/tags
    ⚠ 自签证书，浏览器需点「继续访问」；curl 加 -k
  API 文档（交互式）        http://127.0.0.1:8085
  Grafana 面板              http://127.0.0.1:3000     (admin / admin)
  Prometheus                http://127.0.0.1:9090
  Alertmanager              http://127.0.0.1:9093
  告警接收端日志            deploy/alert-receiver.log

  跑一遍完整业务流程：      python conduit/demo.py
EOF
echo "=============================================================="
[ "$fail" -eq 0 ] && echo " 全部自检通过 ✅" || echo " 有 $fail 项自检未通过（见上面 WARN）"
exit 0
