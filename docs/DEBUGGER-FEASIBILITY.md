# 断点调试可行性评估（P3）

> **结论：当前工具链下不可行。** `llvm-dwarfdump` 读不出 MoonBit native 产物的变量与行号
> —— 不是因为缺工具，而是因为 Windows 上**根本没有 DWARF**，调试信息全在 PDB 里。
> 评估日期 2026-09-23；工具链：moon 0.1.20260915；平台：Windows + VS BuildTools 2022。

## 一、要确认的前提

桌面 IDE 目前没有断点调试。动手前先确认一条前提：

> **`llvm-dwarfdump` 能否从 MoonBit 的 native 产物里读出变量与行号？**

## 二、实测：不能

```bash
moon build -g --target native demo     # -g = Emit debug information
```

产物目录 `_build/native/debug/build/demo/cmd/main/`：

| 文件 | 大小 | 说明 |
|---|---|---|
| `main.c` | 8.2 MB | **生成的 C 代码**（`#include "moonbit.h"` / `moonbit_runtime.h` / `moonbit_simd.h`） |
| `main.obj` | 5.4 MB | MSVC 目标文件 |
| `main.pdb` | 16.0 MB | **Program Database —— 调试信息在这里** |
| `main.ilk` | 5.5 MB | MSVC 增量链接中间文件 |
| `main.exe` | 2.3 MB | PE32+，**8 个节，无 `.debug_*`** |

```
$ file _build/native/debug/build/demo/cmd/main/main.exe
...: PE32+ executable for MS Windows 6.00 (console), x86-64, 8 sections
```

`main.ilk` 是 MSVC 链接器的产物，8 个节是 PE 的常规节 —— **没有 DWARF 节**。

**所以 `llvm-dwarfdump` 没有东西可读。** 这不是"工具没装"，是"格式不对"。

## 三、为什么换不到 DWARF

- **官方文档**：Windows 上 native 后端需要 MSVC 兼容工具链，**支持 `cl.exe` 与 `clang-cl.exe`，
  不支持 MinGW**（其他平台才按 `gcc` → `clang` → `cc` 搜 PATH）。
- **官方源码**（`moonbitlang/moon` 的 `crates/moonutil/src/compiler_flags.rs`）：
  `enum CCKind { Msvc /* cl.exe 或 clang-cl.exe */, SystemCC, Gcc, Clang, Tcc }` ——
  文件名 `cl*` 一律归 `Msvc`，archiver 用 `lib.exe`；MSVC CRT 强制静态 `/MT`，链接带 `/DEBUG`（→ PDB）。
- 有 `MOON_CC` 环境变量可覆盖编译器，但：
  - 换成 `clang-cl.exe` → 仍是 MSVC ABI + `link.exe` → **还是 PDB**；
  - 换成 GNU 驱动的 `clang` / `gcc` → 属官方**明确不支持**的 MinGW 路线。

**结论：这是工具链路线决定的，不是配置问题。**

## 四、本机工具可用性

| 工具 | 状态 |
|---|---|
| `llvm-dwarfdump` | 无（PATH 无，`~/.moon/bin` 无） |
| `llvm-objdump` | 无 |
| `llvm-pdbutil`（读 PDB）| 无 |
| `cdb`（Windows 调试器）| 无 |
| `dia2dump`（DIA SDK）| 无 |

`~/.moon/bin` 只有：`moon*.exe`、`moonc.exe`、`moonfmt.exe`、`mooninfo.exe`、`moondoc.exe`、
`moon-lsp.exe`、`moon-ide.exe`、`moonrun.exe` 等 —— **没有任何调试器**。
VS BuildTools 的 `VC/Tools/Llvm/bin` 里只有 `clang-format.exe` / `clang-tidy.exe`。

## 五、官方有没有调试器支持

- `moon` 子命令表**没有** `debug`（有 build / check / run / test / bench / coverage / doc …）。
- **没有 DAP**（Debug Adapter Protocol）实现。
- **VSCode 插件的调试能力仅限 JavaScript 后端**；native 后端没有官方调试入口。

## 六、可行路径与边界

| 方案 | 能做到 | 代价 / 边界 |
|---|---|---|
| **A. 外部调试器 + PDB 调生成的 C 代码** | 在 `main.c` 层断点、看变量与调用栈 | 断点**不是 `.mbt` 源码级**；要把 PDB 行号映射回 `.mbt` 得自己做；需先装 VS/WinDbg/cdb |
| **B. 等官方提供 DAP 或 DWARF 后端** | 真正的 `.mbt` 源码级调试 | 目前不存在，**本项目无法自己实现** |
| **C. 不做断点，强化现有替代手段** | LSP 补全/跳转/悬停/诊断 + `moon test` + 运行时堆栈行高亮（已实现）| 不是断点调试 |

**建议：采用 C，把 A 记为「可做但有前提」的待办。** 只有当愿意接受
「先装调试器 + 断点在 C 层、不是 `.mbt` 层」时，方案 A 才值得投入。

## 七、复核命令（本页每条结论都能自己验一遍）

```bash
export PATH="$HOME/.moon/bin:$PATH"
cd moonbit-platform

# 1. 产物里是 .pdb/.ilk（MSVC 路线），不是 DWARF
moon build -g --target native demo
ls -la _build/native/debug/build/demo/cmd/main/

# 2. exe 是 PE32+、8 个节，没有 .debug_* 节
file _build/native/debug/build/demo/cmd/main/main.exe

# 3. moon 没有 debug 子命令
moon --help | grep -i debug        # 期望：无输出

# 4. 本机没有 DWARF/PDB 读取工具
for t in llvm-dwarfdump llvm-pdbutil llvm-objdump cdb dia2dump; do which $t || echo "$t: 无"; done
```
