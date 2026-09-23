// 为 Monaco 注册 MoonBit 语言（基础语法高亮）。
// VS Code 用到 LSP 才有的语义能力我们暂不做，这里先把词法层做好。
function registerMoonBit(monaco) {
  monaco.languages.register({ id: 'moonbit', extensions: ['.mbt', '.mbti', '.mbtx'] })

  monaco.languages.setLanguageConfiguration('moonbit', {
    // MoonBit 只有行注释 `//`（含文档注释 `///|`），没有块注释 —— 这点确认过核心库的写法
    comments: { lineComment: '//' },
    brackets: [
      ['{', '}'],
      ['[', ']'],
      ['(', ')'],
    ],
    autoClosingPairs: [
      { open: '{', close: '}' },
      { open: '[', close: ']' },
      { open: '(', close: ')' },
      { open: '"', close: '"' },
    ],
    surroundingPairs: [
      { open: '{', close: '}' },
      { open: '[', close: ']' },
      { open: '(', close: ')' },
      { open: '"', close: '"' },
    ],
    // 标识符：MoonBit 允许下划线与数字，且 `!` 可作后缀（如 `not_!` 风格的方法名）
    wordPattern: /[a-zA-Z_][a-zA-Z0-9_]*!?/,

    // ---- 自动缩进 ----
    // 行尾是 `{` / `=` / `=>` / `->` 时，下一行要缩进；
    // 行首是 `}` 时要退一级。
    indentationRules: {
      increaseIndentPattern: /(\{|\=|=>|->)\s*(?:\/\/.*)?$/,
      decreaseIndentPattern: /^\s*\}/,
    },
    // 回车时的行为（比 indentationRules 更精细：区分"在 { 后回车"和"在 } 前回车"）
    onEnterRules: [
      {
        // 光标在 `{` 之后回车，且下一行是 `}` → 一次回车补成两行并居中缩进
        beforeText: /\{\s*$/,
        afterText: /^\s*\}/,
        action: { indentAction: monaco.languages.IndentAction.IndentOutdent },
      },
      {
        // 在 `{` 后回车 → 只增加缩进
        beforeText: /\{\s*$/,
        action: { indentAction: monaco.languages.IndentAction.Indent },
      },
      {
        // 空行后跟着 `}` → 减少缩进
        beforeText: /^\s*$/,
        afterText: /^\s*\}/,
        action: { indentAction: monaco.languages.IndentAction.Outdent },
      },
    ],
  })

  monaco.languages.setMonarchTokensProvider('moonbit', {
    keywords: [
      'fn', 'let', 'mut', 'const', 'type', 'struct', 'enum', 'trait', 'impl',
      'match', 'if', 'else', 'while', 'for', 'in', 'break', 'continue', 'return',
      'pub', 'priv', 'async', 'await', 'raise', 'try', 'catch', 'noraise',
      'derive', 'suberror', 'extern', 'test', 'init', 'main', 'self', 'Self',
      'true', 'false', 'guard', 'defer', 'errdefer', 'is', 'as', 'extend',
      'open', 'using', 'with', 'opaque',
    ],
    typeKeywords: [
      'Int', 'Int64', 'Double', 'Float', 'String', 'Bool', 'Unit', 'Bytes',
      'Array', 'FixedArray', 'Option', 'Result', 'Char', 'Byte', 'Json',
      'Buffer', 'Ref', 'Map', 'Set',
    ],
    tokenizer: {
      root: [
        [/\/\/\/\|/, 'comment.doc'],
        [/\/\/.*$/, 'comment'],
        [/".*?"/, 'string'],
        [/'(\\.|[^'\\])'/, 'string'],
        [/[a-zA-Z_]\w*!/, 'keyword'],
        [
          /[a-zA-Z_]\w*/,
          { cases: { '@keywords': 'keyword', '@typeKeywords': 'type', '@default': 'identifier' } },
        ],
        [/\d+(\.\d+)?([eE][-+]?\d+)?/, 'number'],
        [/[{}()[\]]/, '@brackets'],
        // 注意：这里**不能**写 `[/[<>](?!@symbols)/, '@brackets']`。
        // 那行是从 VS Code 的 Monarch 示例抄来的，引用了语言配置里的 `symbols` 属性；
        // 我们没定义它，Monaco 会直接抛
        //   「moonbit: language definition does not contain attribute 'symbols'」
        // 导致 monaco.editor.create() 失败 —— 界面上就是"编辑器完全不出来"。
        // 而且 MoonBit 的泛型用 `Array[String]`（方括号），`<` `>` 是运算符而非括号，
        // 交给下面的 operator 规则处理才是对的。
        [/[=><!~?:&|+\-*/^%]+/, 'operator'],
      ],
    },
  })
}

if (typeof module !== 'undefined') module.exports = { registerMoonBit }
