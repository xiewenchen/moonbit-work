# PH3-IPC-01/02/03：IPC 清单审计（分类 / 风险 / 重复 / 未配对）

- 日期：2026-09-26
- 工具：`tools/audit-ipc.js`（`--json` / `--ci`），已挂 CI
- 结果：**134 个入口**（资料写 149，以实测为准）

## 清单一、二、三项的结论

| 项 | 结论 |
|---|---|
| PH3-IPC-01 扫描全部 IPC | 134 个 handler / 132 个 invoke，owner 分布：main.js 20、relay-main 13、lsp-manager 12、workbench-main 9、memory-main 8… |
| PH3-IPC-02 按领域分类 | project / file / runner / lsp / agent / provider / database / quality / other 九类，逐条列出 |
| PH3-IPC-03 识别重复 IPC | **0 组**（清单点名的 `getProject / projectInfo / currentProject` **不存在**） |

## 风险分级（PH3-IPC-05 的输入）

29 个高危入口，按 `write` / `exec` / `secret` 打标，例如：

```
[write+secret] agent:config:set      agent.js
[exec]         agent:run             agent.js
[write]        fs:write              main.js
[write]        aiProvider:save       ai-provider-main.js
[exec]         runner:run            runners.js
[write]        session:save          session-main.js
```

## ★ 最有价值的一条：**未配对的 invoke = 0**

工具会找"调用方存在但没有 handler"的 channel —— 那种情况**点了完全没反应，也不报错**
（与 PH3-V 修的"事件处理器调不存在的函数"是同一类）。结论是 **0 个**。

顺带查出 2 个"有 handler 但没人 invoke"：`agentPatch:pending`、`workbench:save`。
核对后**都不是缺陷** —— `workbench:save` 没在 preload 暴露，渲染侧走
`wbSetNote` / `wbAddTodo` 等细粒度入口，它是"备用整存口"。

## ★ 又踩一次：挂 CI 的 YAML 写错，而我没按 CI 的方式验证

我把新检查追加到已有的 `run: node tools/check-local-chk.js --ci` 后面 ——
**那是单行 `run:`，不是 `run: |` 块**，多出来的缩进行直接让 YAML 语法错
（`expected <block end>, but found '<scalar>'`）。而且**我上一次提交就把它推上去了**。

> 这是"**挂 CI 的东西必须按 CI 的命令行原样跑过一遍**"的**第二次**教训
>（第一次是 `check-handler-refs.js` 的 `--ci` 被当成目录）。
> 区别是：第一次我看输出发现了，这一次**我是靠 `yaml.safe_load` 才发现的** ——
> 说明"跑一遍"必须包含**校验 YAML 本身**这一步。

修法：改成 `run: |` 块，并把三个静态检查放在同一个块里。

**另**：验证时我又一次把命令写错（`node "tools/x.js --ci"` 把开关拼进了文件名），
得到"全部 EXIT=1"的假结果 —— **假红也会浪费时间**，与假绿一样该被当场识破。

## 验证

`audit-ipc --ci` 双向自测：注入一个 `ipcRenderer.invoke('notARealChannel:xyz')` →
`--ci` **exit 1** 且精确报出 `preload.js:239`；还原后 **exit 0**。
CI 五个静态检查逐条 `EXIT=0`；纯 Node 42 个。
