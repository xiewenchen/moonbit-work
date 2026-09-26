# PH3-BE-01/06/07/08/09/11：后端 Profile / 状态机 / OpenAPI 发现 / 错误进问题模型 / 健康进 Quality

- 日期：2026-09-26
- 新增：`desktop/backend-profile.js` + `test-backend-profile.js`（**80/0**），已挂 CI

## 边界

`backend-context.js`（端口推断、健康 URL）与 `backend.js`（status/health/build/start/stop）
保持不动；新层补清单 §9 缺的几件。

## ★ 状态机比清单多一个状态

清单写 STOPPED / STARTING / RUNNING / FAILED，但**后端有个真实情况它没覆盖**：
进程活着、健康检查不过。那既不是 RUNNING 也不是 FAILED，所以加了 **DEGRADED**。

> RUNNING → DEGRADED → RUNNING 是真实存在的循环（服务起来了但依赖挂了，之后恢复）。
> 如果只有四态，这种情况只能被迫报 FAILED —— 那会把"依赖暂时不可用"说成"后端挂了"。

拒掉的迁移也**记进时间线**（否则事后看不出"当时想改但没改成"）。

## PH3-BE-07/08：OpenAPI 发现是"自动加载 API Debug"的地基

只认**真实结构**（`paths` + HTTP 方法），**不做"看到 /v1 就当端点"的猜测** ——
列错了比不列更糟。同时支持 OpenAPI 3 与 **Swagger 2**（后者的 `basePath` 要拼进路径）。
`toDebugRequests` 生成可用的请求模板，并带上该端点是否声明了鉴权。

## PH3-BE-09：后端错误进**统一问题模型**（而不是另开一处）

从日志里按形状取错误行（`Error`/`panic`/`FATAL`/`ECONNREFUSED`…），
尽量从 `file:line` 里取文件与行号 —— **取不到就留 null，不编一个行号**。
正常行与请求日志（`GET /users 200`）不误报。

## PH3-BE-11：健康 → Quality 的**三态**

`PASS`（健康）/ `FAIL`（探测了但不健康）/ **`NOT_RUN`（根本没探测）**。
后两者不能混：**"连不上"与"没去连"是两回事**，混了会让 Quality 把"没做"说成"失败"。

## Profile：取不到就留 null

尤其 `port` —— **不猜 8080**。猜错了会去连**别人的服务**。`profileReadiness` 缺关键项就
明确说"不能发起健康检查"，而不是硬试一下再说。

## 验证

`test-backend-profile` **80/0**，第一组仍是 `null` 边界（按记忆 `js-default-param-null`）。
过程中只有一处我自己的数错（把 4 个端点当 3 个），不是代码问题。
