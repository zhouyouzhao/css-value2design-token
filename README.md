# value2design-token README

✨ A VS Code extension for Tailwind CSS v4 — select raw CSS values (#1E90FF, 16px, etc.), instantly replace them with design tokens (var(--color-primary)), and auto-create new tokens with smart naming when missing.

## Features

- 🔍 **智能识别**：自动识别 CSS 值并匹配 design tokens
- 🏷️ **别名支持**：通过 `@alias` 注释为 token 定义别名，支持 Tailwind 工具类快速替换
- 🎯 **快速替换**：一键替换为 `var(--token)` 或使用别名替换
- 📂 **文件浏览**：查看所有已索引的 design token 文件
- 🔗 **跳转定义**：快速跳转到 token 定义位置

## @alias 别名功能

### 定义别名

在 design token 声明前添加 `@alias` 注释：

```css
:root {
  // @alias xl
  --spacing-xl: 20px;
  
  /* @alias primary */
  --color-primary: #1E90FF;
}
```

### 使用别名

1. 选中值（如 `20px`）
2. 右键选择 "Find Design Token"
3. 在选择器中：
   - **回车**：替换为 `var(--spacing-xl)`
   - **点击别名图标**：替换为 `xl`

## @pattern 替换模式

通过在别名后添加模式，让替换更智能，支持各种框架语法：

### Tailwind CSS 方括号

```css
// @alias xl [%]
--spacing-xl: 20px;
```

使用效果：`text-[20px]` → 选中 `20px` → 点击别名 → `text-xl`

### 其他模式

```css
// CSS 变量
// @alias primary var(%%)
--color-primary: #1E90FF;

// 函数调用
// @alias full calc(%)
--full-width: 100%;

// 无模式（只替换值本身）
// @alias accent
--color-accent: #FF6B6B;
```

**`%` 代表选中的值**，模式定义了替换时包含的前后文本。

详细说明请查看 [./PATTERN_GUIDE.md]

## Important

This extension only supports global design tokens (:root / @theme) and their theme overrides (e.g. .dark, [data-theme]).
Variables defined outside this scope are treated as non-standard and will be ignored.

## Development

### Testing

This extension includes comprehensive unit tests for the indexer functionality:

```bash
# Run all tests (including linting and compilation)
pnpm test

# Run only indexer unit tests
pnpm run test:indexer

# Run unit tests (alias for test:indexer)
pnpm run test:unit

# Compile tests without running
pnpm run compile-tests

# Watch mode for test compilation
pnpm run watch-tests
```

### Available Scripts

- `pnpm run compile` - Compile the extension using webpack
- `pnpm run watch` - Watch mode for development
- `pnpm run package` - Build production package
- `pnpm run package:vsix` - Create VSIX package for installation
- `pnpm run install:local` - Install extension locally in Cursor
- `pnpm run install:local:vscode` - Install extension locally in VS Code
- `pnpm run test:indexer` - Run indexer unit tests
- `pnpm run test:unit` - Run all unit tests
- `pnpm run lint` - Run ESLint on source code
