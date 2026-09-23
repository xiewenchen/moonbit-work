# xiewenchen/moonbit-platform

用纯 MoonBit 从零实现的后端开发平台：**HTTP/1.1**（服务端 + 客户端）、**Redis**、**PostgreSQL**，
外加应用框架层（路由 / 中间件 / JWT / 令牌桶限流 / Prometheus 指标）与工具链（SQL 迁移 / 压测 / 多进程启动器）。
协议层零依赖，`wasm-gc` 目标可测。

- mooncakes：`xiewenchen/moonbit-platform@0.1.0`
- 仓库：https://github.com/xiewenchen/moonbit-work
- 许可证：Apache-2.0

## 快速开始

```bash
export PATH="$HOME/.moon/bin:$PATH"

moon check --deny-warn        # 编译检查（0 警告）
moon test --target native     # 156 通过 / 0 失败
moon test --target wasm-gc    # 79 通过 / 0 失败（协议层，零依赖）
```

## 测试

- **单元测试（默认）**：`moon test --target native`
  集成测试已标记 `#skip`（依赖本地 PostgreSQL / Redis）。
- **完整测试**：先启动本地服务，再跑 `moon test --target native --include-skipped`
  需要：PostgreSQL `localhost:55432`（auth 测试用 `55434`，数据库 `mbptest`）、Redis `localhost:6379`。

CI（GitHub Actions）只跑单元测试。8 个集成测试的跳过原因见各测试文件内的 `#skip("...")` 注释。

## 目录

| 目录 | 内容 |
|---|---|
| `http/` `redis/` `pg/` | 协议层（零依赖）与连接层（仅 native） |
| `app/` | 框架层：Config / Router / 中间件 / JWT / 限流 / 指标 |
| `db/` `bench/` `cluster/` | 工具链：SQL 迁移 / 压测 / 多进程 |
| `conduit/` | 按 RealWorld 规范实现的后端 + 官方 hurl 套件（13 套件 / 154 请求） |
| `sec/` | 安全靶场 + `attack.py`（14 小节 / 18 项断言） |
| `desktop/` | 配套桌面 IDE（Electron + Monaco，**不属于 MoonBit 交付物**） |
| `docs/` | 架构 / 安全 / 漏洞记录 / 验证 / 查重 / 归属 / 调试可行性 等 11 份文档 |

## 复核命令（对外引用的每个数字都可现场复核）

```bash
git log --oneline | wc -l            # 31 个 commit
find . -name 'moon.pkg' -not -path './_build/*' -not -path './.mooncakes/*' | wc -l   # 28 个包
find . -name '*.mbt' -not -path './_build/*' -not -path './.mooncakes/*' | xargs wc -l | tail -1   # 11209 行
moon test --target native            # 156 通过
moon test --target wasm-gc           # 79 通过
ls conduit/specs-hurl/*.hurl | wc -l # 13 套件
grep -hE "^(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS) " conduit/specs-hurl/*.hurl | wc -l   # 154 请求
grep -cE "^# -+ [0-9]+" sec/attack.py                        # 14 小节
grep -v "^def check" sec/attack.py | grep -c "check("        # 18 断言
ls docs/*.md | wc -l                 # 11 份文档
```

项目全貌（架构 / 各模块现状 / 交付状态 / 待办）见 [`docs/PROJECT-SUMMARY.md`](docs/PROJECT-SUMMARY.md)；
安全加固与缺陷记录见 [`docs/VULNERABILITIES.md`](docs/VULNERABILITIES.md)。
