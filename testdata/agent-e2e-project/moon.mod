// P9C 的 E2E 靶项目（Phase 2.1）
//
// 刻意做成**独立、零依赖**的最小模块：
//   · 不依赖 moonbit-platform 的任何包 → `moon check` 只需要编译器，不受本机其它环境影响
//   · 足够小 → 出问题时一眼能看完，适合当"第一次真正的 Agent E2E"的靶子
//
// 这个文件里**没有**故意错误；错误由 E2E 脚本按需注入（见 verify-agent-e2e.js），
// 这样才能"先确认干净时是绿的，再确认注入后是红的"。
name = "e2e/agent-demo"
version = "0.1.0"
