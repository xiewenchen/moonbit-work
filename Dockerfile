# MoonBit 后端平台 —— 多阶段镜像
#
# 阶段 1：用 MoonBit 工具链构建 native 可执行文件
# 阶段 2：精简运行镜像（只带二进制）
#
# 构建：  docker build -t moonbit-platform .
# 运行：  docker run --rm -p 8080:8080 \
#           -e MBP_PG_HOST=host.docker.internal -e MBP_REDIS_HOST=host.docker.internal \
#           moonbit-platform
#
# 安全要点：
#   - 运行阶段**以非 root 用户**运行（最小权限）
#   - HEALTHCHECK 打 `/health`，而不是「再启动一次应用」
#   - 构建依赖未钉死版本（`curl | bash` 供应链风险），生产建议改为固定版本 + 校验和

# --------------------------- build ---------------------------
FROM ubuntu:24.04 AS build

RUN apt-get update \
  && apt-get install -y --no-install-recommends curl ca-certificates gcc libc6-dev \
  && rm -rf /var/lib/apt/lists/*

# 安装 MoonBit 工具链（含 native 后端所需的 C 工具链）
# 注意：这是「从网络直取脚本执行」，属供应链风险点 —— 生产应改为
# 下载固定版本 + 校验 SHA256，或使用官方镜像层
RUN curl -fsSL https://cli.moonbitlang.com/install/unix.sh | bash
ENV PATH="/root/.moon/bin:${PATH}"

WORKDIR /src
COPY . .

# 构建示例服务（native 后端）
RUN moon build --target native notes/cmd/main

# 找出生成的可执行文件，统一放到 /out/app
RUN set -eux; \
  bin="$(find _build/native -type f -name 'main.exe' -o -type f -name 'main' | head -n 1)"; \
  test -n "$bin"; \
  mkdir -p /out; \
  cp "$bin" /out/app

# --------------------------- runtime -------------------------
FROM debian:bookworm-slim

# 只装探针所需的最小依赖（curl 用于 HEALTHCHECK）
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl \
  && rm -rf /var/lib/apt/lists/*

# 非 root 运行（最小权限原则）
RUN useradd --system --create-home --shell /usr/sbin/nologin appuser

COPY --from=build /out/app /usr/local/bin/app

# 默认监听 8080；依赖 PG/Redis 用环境变量指向
ENV MBP_HOST=0.0.0.0
ENV MBP_PORT=8080
EXPOSE 8080

USER appuser

# 存活探针：请求 /health（而非重新运行应用）
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD curl -fsS http://127.0.0.1:8080/health || exit 1

ENTRYPOINT ["/usr/local/bin/app"]
