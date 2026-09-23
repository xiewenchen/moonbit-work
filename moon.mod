// Learn more about moon.mod configuration:
// https://docs.moonbitlang.com/en/latest/toolchain/moon/module.html
//
// To add a dependency, run this command in your terminal:
//   moon add moonbitlang/x
//
// Or manually declare it in `import`, for example:
// import {
//   "moonbitlang/x@0.4.6",
// }

name = "mbp/platform"

version = "0.1.0"

readme = "README.mbt.md"

repository = "https://github.com/xiewenchen/moonbit-work"

license = "Apache-2.0"

keywords = [ "redis", "postgresql", "http", "backend", "web", "protocol" ]

preferred_target = "wasm"

description = "纯 MoonBit 实现的后端开发平台：Redis / PostgreSQL 协议驱动 + HTTP 1.1 服务端 + 应用框架层与工具链"

import {
  "moonbitlang/async@0.22.1",
  "moonbitlang/x@0.5.5",
}
