# 静态检查：事件处理器里调用了不存在的函数

- 日期：2026-09-26
- 工具：`tools/check-handler-refs.js`（`--ci`），已挂 CI
- 结果：**0 处**（扫了 135 个处理器 / 70 个文件）—— 没有真 bug

## 为什么加它

上一批修的是"面板打开永远空白"（`showOfficePanel` 漏调 `refresh()`）。它的本质是
**点了/开了完全没反应，而且不报错**。事件处理器里有同一类问题：

```js
btn.onclick = () => somFunction()   // 名字打错 → 点了没反应
```

这种错**抛在 UI 事件里**，用户看不见、不进日志、`node --check` 也不管（语法合法）。
所以做一个静态检查：扫每个 `onclick/onchange/…` 里的调用，看名字在**本文件**里有没有出现。

## 判据（尽量少误报 —— 误报会让人不信工具）

- **定义端**：扫**整个文件**的 `function X`、`const/let/var X =`、解构
  `const [a, X] of`、`const { a, X } =`、箭头/普通函数参数、for-of 绑定；
- **调用端**：只看事件处理器那一行，且用 `(?<![\w$.])` 排除 `obj.fn(`（方法调用）；
- 关键字（`if/for/async/await/…`）与内置全局（`console/setTimeout/…`）不报。

## ★ 踩了一个"跨语言习惯"的坑

第一版跑出 **43 处误报**，其中 35 处报的是 `async()`、8 处报 `if()` —— 而 `KEYWORDS` 里
**明明写了** `if`。查下去发现根因是：

```js
new Set('if for while …'.split())    // ✗ JS 的 split() 无参**不分割**，返回 [原串]
new Set('if for while …'.split(/\s+/))  // ✓
```

**JS 的 `String.prototype.split()` 无参数时返回 `[原字符串]`**，和 Python 的 `str.split()`
（按空白分）**不一样**。所以那个 Set 里只有一个长字符串，`has('if')` 恒为 false，
于是每个关键字都被当成"未定义函数"报了出来。（`async` 还额外从 `KEYWORDS` 里漏了。）

> 教训：**误报和漏报一样有害**。43 处误报的后果不是"多看几眼"，而是这个工具当场失去可信度。
> 所以我先把它修到 0，再决定留下它。

## 自测（双向）

1. 往 `renderer.js` 追加 `document.body.firstChild.onclick = () => notDefinedAnywhere(1)`
   → `--ci` **exit 1**，并精确报出文件名、行号、`notDefinedAnywhere()`（**能抓**）；
2. 用 `git checkout --` 还原 → `--ci` **exit 0**（**不误报**）。

## 为什么不进 CI 的"Electron 那一半"

这个工具是**纯静态**的（只读 JS 源），不需要窗口，所以**可以**进 CI —— 已经挂了。
（对比 `verify-*.js` 是 Electron 脚本，那条线仍留在本地。）

## ★ 又踩一个：`--ci` 被当成目录 —— 而且已经挂进 CI 了

工具刚写完、**已经挂上 CI**，我才发现它自己有个 bug：

```js
const ROOT = path.resolve(process.argv[2] || …)   // ✗
```

`argv[2]` 在 `node tools/x.js --ci` 时就是 `'--ci'` → 被当成目录 →
`ENOENT: scandir '…/moonbit-platform/--ci'` 直接崩。也就是**我刚挂的那行 CI 是坏的**。

修法：先把参数分一遍 —— `--` 开头的是开关，不是路径：

```js
const ARGV = process.argv.slice(2)
const CI_MODE = ARGV.includes('--ci')
const POSITIONAL = ARGV.filter((a) => !a.startsWith('--'))
```

> 这里最该记的不是这个 bug 本身，而是**它差点被漏过去**：
> 我在同一条命令里「挂 CI → 顺手验证」，验证那步因为前一步的 `&&` 链没走完而**没跑成**，
> 而我是**看输出才发现** node 崩了的。如果那步被跳过或输出被 `| tail` 吃掉，
> 我交付的就是"一个让 CI 变红的检查"。
> **凡是挂了 CI 的东西，必须按 CI 的命令行原样跑过一遍。**
