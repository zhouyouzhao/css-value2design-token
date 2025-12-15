import * as assert from "assert";
import * as vscode from "vscode";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { TokenIndex, TokenHit } from "../core/indexer";

// 从 package.json 读取默认配置
const packageJson = require("../../package.json");
const defaultConfig = packageJson.contributes.configuration.properties;

suite("TokenIndex Test Suite", () => {
  let tempDir: string;
  let tokenIndex: TokenIndex;
  let workspaceFolder: vscode.WorkspaceFolder;
  let originalGetConfiguration: any;
  let originalWorkspaceFolders: any;

  // 使用 package.json 中的默认配置，但为测试调整sources模式
  const mockConfig = {
    sources: ["**/*.css"], // 使用递归模式以便在临时目录中找到文件
    "index.classWhitelist":
      defaultConfig["css-value2design-token.index.classWhitelist"].default,
  };

  // 用于测试类白名单功能的配置
  const mockConfigWithClassWhitelist = {
    sources: ["**/*.css"],
    "index.classWhitelist": [
      "^\\.theme-",
      "^\\.(dark|light)$",
      "^\\[data-theme=",
    ],
  };

  suiteSetup(async () => {
    // 创建临时目录
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "indexer-test-"));

    // 模拟工作区文件夹
    workspaceFolder = {
      uri: vscode.Uri.file(tempDir),
      name: "test-workspace",
      index: 0,
    };

    // 保存原始方法
    originalGetConfiguration = vscode.workspace.getConfiguration;
    originalWorkspaceFolders = vscode.workspace.workspaceFolders;
  });

  suiteTeardown(async () => {
    // 恢复原始方法
    vscode.workspace.getConfiguration = originalGetConfiguration;
    Object.defineProperty(vscode.workspace, "workspaceFolders", {
      value: originalWorkspaceFolders,
      configurable: true,
    });

    // 清理临时目录
    try {
      await fs.rm(tempDir, { recursive: true, force: true });
    } catch (error) {
      // 忽略清理错误
    }
  });

  setup(async () => {
    // 为每个测试创建新的临时目录
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "indexer-test-"));

    // 更新工作区文件夹
    workspaceFolder = {
      uri: vscode.Uri.file(tempDir),
      name: "test-workspace",
      index: 0,
    };

    // 设置模拟的 vscode API
    vscode.workspace.getConfiguration = (section?: string) => {
      if (section === "css-value2design-token") {
        return {
          get: (key: string) => mockConfig[key as keyof typeof mockConfig],
          has: () => true,
          inspect: () => undefined,
          update: () => Promise.resolve(),
        } as any;
      }
      return originalGetConfiguration(section);
    };

    Object.defineProperty(vscode.workspace, "workspaceFolders", {
      value: [workspaceFolder],
      configurable: true,
    });

    // 创建新的索引实例
    tokenIndex = new TokenIndex();
  });

  teardown(async () => {
    // 清理当前测试的临时目录
    try {
      await fs.rm(tempDir, { recursive: true, force: true });
    } catch (error) {
      // 忽略清理错误
    }
  });

  test("should initialize empty index", () => {
    assert.strictEqual(tokenIndex.isReady(), false);
    assert.deepStrictEqual(tokenIndex.findByValue("normalized-value"), []);
  });

  test("should use default configuration from package.json", () => {
    // 验证我们使用的配置与 package.json 中的默认配置一致（现在是空数组）
    const expectedClassWhitelist: string[] = [];

    assert.deepStrictEqual(
      mockConfig["index.classWhitelist"],
      expectedClassWhitelist,
      "测试配置应该与 package.json 中的默认配置保持一致",
    );
  });

  test("should index tokens from :root selector", async () => {
    // 创建测试 CSS 文件
    const cssContent = `
:root {
  --primary-color: #3b82f6;
  --secondary-color: rgb(59, 130, 246);
  --spacing-large: 2rem;
}
		`;

    const testFile = path.join(tempDir, "test-root.css");
    await fs.writeFile(testFile, cssContent);

    await tokenIndex.build();

    assert.strictEqual(tokenIndex.isReady(), true);

    // 测试颜色值查找
    const colorHits = tokenIndex.findByValue("#3b82f6");
    assert.strictEqual(colorHits.length, 1);
    assert.strictEqual(colorHits[0].name, "--primary-color");
    assert.strictEqual(colorHits[0].value, "#3b82f6");
    assert.strictEqual(colorHits[0].selector, ":root");
    assert.strictEqual(colorHits[0].source, "root");

    // 测试 RGB 值查找（应该被归一化）
    const rgbHits = tokenIndex.findByValue("rgb(59,130,246)");
    assert.strictEqual(rgbHits.length, 1);
    assert.strictEqual(rgbHits[0].name, "--secondary-color");
  });

  test("should index tokens from html selector", async () => {
    const cssContent = `
html {
  --html-font-size: 16px;
  --html-line-height: 1.5;
}
		`;

    const testFile = path.join(tempDir, "test-html.css");
    await fs.writeFile(testFile, cssContent);

    await tokenIndex.build();

    const hits = tokenIndex.findByValue("16px");
    assert.strictEqual(hits.length, 1);
    assert.strictEqual(hits[0].name, "--html-font-size");
    assert.strictEqual(hits[0].selector, "html");
    assert.strictEqual(hits[0].source, "root");
  });

  test("should index tokens from data-theme attribute selectors", async () => {
    const cssContent = `
[data-theme="dark"] {
  --theme-bg: #1f2937;
  --theme-text: #cccccc;
}

html[data-theme="light"] {
  --theme-bg: #f8f9fa;
  --theme-text: #000000;
}
		`;

    const testFile = path.join(tempDir, "test-data-theme.css");
    await fs.writeFile(testFile, cssContent);

    await tokenIndex.build();

    const darkBgHits = tokenIndex.findByValue("#1f2937");
    assert.strictEqual(darkBgHits.length, 1);
    assert.strictEqual(darkBgHits[0].name, "--theme-bg");
    assert.strictEqual(darkBgHits[0].selector, '[data-theme="dark"]');
    assert.strictEqual(darkBgHits[0].source, "scoped");

    const lightBgHits = tokenIndex.findByValue("#f8f9fa");
    assert.strictEqual(lightBgHits.length, 1);
    assert.strictEqual(lightBgHits[0].selector, 'html[data-theme="light"]');
    assert.strictEqual(lightBgHits[0].source, "scoped");
  });

  test("should index tokens from @theme at-rule", async () => {
    const cssContent = `
@theme {
  --theme-primary: #8b5cf6;
  --theme-secondary: #a78bfa;
}
		`;

    const testFile = path.join(tempDir, "test-theme-rule.css");
    await fs.writeFile(testFile, cssContent);

    await tokenIndex.build();

    const hits = tokenIndex.findByValue("#8b5cf6");
    assert.strictEqual(hits.length, 1);
    assert.strictEqual(hits[0].name, "--theme-primary");
    assert.strictEqual(hits[0].selector, "theme");
    assert.strictEqual(hits[0].source, "theme");
  });

  test("should index tokens from class whitelist selectors", async () => {
    // 临时设置带有类白名单的配置
    vscode.workspace.getConfiguration = (section?: string) => {
      if (section === "css-value2design-token") {
        return {
          get: (key: string) =>
            mockConfigWithClassWhitelist[key as keyof typeof mockConfigWithClassWhitelist],
          has: () => true,
          inspect: () => undefined,
          update: () => Promise.resolve(),
        } as any;
      }
      return originalGetConfiguration(section);
    };

    // 创建新的索引实例以使用新配置
    tokenIndex = new TokenIndex();

    const cssContent = `
.theme-light {
  --light-bg: #f1f5f9;
  --light-text: #0f172a;
}

.theme-dark {
  --dark-bg: #0f172a;
  --dark-text: #f1f5f9;
}

.dark {
  --dark-accent: #60a5fa;
}

.light {
  --light-accent: #3b82f6;
}

/* 这个不应该被索引 */
.my-component {
  --component-color: #ff0000;
}

/* 这个也不应该被索引 */
.button {
  --button-bg: #00ff00;
}
		`;

    const testFile = path.join(tempDir, "test-class-whitelist.css");
    await fs.writeFile(testFile, cssContent);

    await tokenIndex.build();

    // 测试主题类
    const lightBgHits = tokenIndex.findByValue("#f1f5f9");
    assert.strictEqual(lightBgHits.length, 2); // 应该找到两个（--light-bg 和 --dark-text）
    const lightBgHit = lightBgHits.find((h) => h.name === "--light-bg");
    assert.ok(lightBgHit);
    assert.strictEqual(lightBgHit.selector, ".theme-light");
    assert.strictEqual(lightBgHit.source, "scoped");

    const darkBgHits = tokenIndex.findByValue("#0f172a");
    assert.strictEqual(darkBgHits.length, 2); // 应该找到两个（--dark-bg 和 --light-text）
    const darkBgHit = darkBgHits.find((h) => h.name === "--dark-bg");
    assert.ok(darkBgHit);
    assert.strictEqual(darkBgHit.selector, ".theme-dark");

    // 测试 dark/light 类
    const darkAccentHits = tokenIndex.findByValue("#60a5fa");
    assert.strictEqual(darkAccentHits.length, 1);
    assert.strictEqual(darkAccentHits[0].selector, ".dark");

    const lightAccentHits = tokenIndex.findByValue("#3b82f6");
    assert.strictEqual(lightAccentHits.length, 1);
    assert.strictEqual(lightAccentHits[0].selector, ".light");

    // 验证不在白名单的类没有被索引
    const componentColorHits = tokenIndex.findByValue("#ff0000");
    assert.strictEqual(componentColorHits.length, 0);

    const buttonBgHits = tokenIndex.findByValue("#00ff00");
    assert.strictEqual(buttonBgHits.length, 0);
  });

  test("should NOT index class selectors when classWhitelist is empty", async () => {
    // 使用默认的空白名单配置
    vscode.workspace.getConfiguration = (section?: string) => {
      if (section === "css-value2design-token") {
        return {
          get: (key: string) => mockConfig[key as keyof typeof mockConfig],
          has: () => true,
          inspect: () => undefined,
          update: () => Promise.resolve(),
        } as any;
      }
      return originalGetConfiguration(section);
    };

    // 创建新的索引实例
    tokenIndex = new TokenIndex();

    const cssContent = `
.theme-light {
  --light-bg: #f1f5f9;
  --light-text: #0f172a;
}

.theme-dark {
  --dark-bg: #0f172a;
  --dark-text: #f1f5f9;
}

.dark {
  --dark-accent: #60a5fa;
}

.my-component {
  --component-color: #ff0000;
}

/* 但是这些应该继续被索引 */
:root {
  --root-color: #1e40af;
}

html {
  --html-color: #fbbf24;
}

[data-theme="custom"] {
  --custom-color: #8b5cf6;
}
		`;

    const testFile = path.join(tempDir, "test-no-class-whitelist.css");
    await fs.writeFile(testFile, cssContent);

    await tokenIndex.build();

    // 验证类选择器的 tokens 没有被索引
    const lightBgHits = tokenIndex.findByValue("#f1f5f9");
    assert.strictEqual(lightBgHits.length, 0, "类选择器的tokens不应该被索引");

    const darkAccentHits = tokenIndex.findByValue("#60a5fa");
    assert.strictEqual(darkAccentHits.length, 0, "类选择器的tokens不应该被索引");

    const componentColorHits = tokenIndex.findByValue("#ff0000");
    assert.strictEqual(componentColorHits.length, 0, "类选择器的tokens不应该被索引");

    // 但是传统的选择器应该继续工作
    const rootHits = tokenIndex.findByValue("#1e40af");
    assert.strictEqual(rootHits.length, 1);
    assert.strictEqual(rootHits[0].selector, ":root");

    const htmlHits = tokenIndex.findByValue("#fbbf24");
    assert.strictEqual(htmlHits.length, 1);
    assert.strictEqual(htmlHits[0].selector, "html");

    const dataThemeHits = tokenIndex.findByValue("#8b5cf6");
    assert.strictEqual(dataThemeHits.length, 1);
    assert.strictEqual(dataThemeHits[0].selector, '[data-theme="custom"]');
  });

  test("should handle multiple selectors separated by commas", async () => {
    // 重置为默认配置（空白名单）
    vscode.workspace.getConfiguration = (section?: string) => {
      if (section === "css-value2design-token") {
        return {
          get: (key: string) => mockConfig[key as keyof typeof mockConfig],
          has: () => true,
          inspect: () => undefined,
          update: () => Promise.resolve(),
        } as any;
      }
      return originalGetConfiguration(section);
    };

    tokenIndex = new TokenIndex();

    const cssContent = `
:root, html {
  --global-primary: #1e40af;
}

[data-theme="light"], [data-theme="dark"] {
  --theme-border: #d1d5db;
}
		`;

    const testFile = path.join(tempDir, "test-multiple-selectors.css");
    await fs.writeFile(testFile, cssContent);

    await tokenIndex.build();

    const primaryHits = tokenIndex.findByValue("#1e40af");
    assert.strictEqual(primaryHits.length, 1);
    assert.strictEqual(primaryHits[0].name, "--global-primary");

    const borderHits = tokenIndex.findByValue("#d1d5db");
    assert.strictEqual(borderHits.length, 1);
    assert.strictEqual(borderHits[0].name, "--theme-border");
  });

  test("should skip invalid CSS files gracefully", async () => {
    const invalidCssContent = `
.invalid {
  --color: #123456
  /* missing semicolon and closing brace
		`;

    const testFile = path.join(tempDir, "test-invalid.css");
    await fs.writeFile(testFile, invalidCssContent);

    // 应该不抛出异常
    await tokenIndex.build();
    assert.strictEqual(tokenIndex.isReady(), true);
  });

  test("should handle non-existent files gracefully", async () => {
    // 临时修改配置指向不存在的文件
    const tempConfig = {
      ...mockConfig,
      sources: ["non-existent-*.css"],
    };

    vscode.workspace.getConfiguration = (section?: string) => {
      if (section === "css-value2design-token") {
        return {
          get: (key: string) => tempConfig[key as keyof typeof tempConfig],
          has: () => true,
          inspect: () => undefined,
          update: () => Promise.resolve(),
        } as any;
      }
      return originalGetConfiguration(section);
    };

    // 应该不抛出异常
    await tokenIndex.build();
    assert.strictEqual(tokenIndex.isReady(), true);
    assert.strictEqual(tokenIndex.findByValue("any-value").length, 0);
  });

  test("should handle file changes incrementally", async () => {
    // 初始文件
    const initialContent = `
:root {
  --original-color: #123456;
}
		`;

    const testFile = path.join(tempDir, "test-incremental.css");
    await fs.writeFile(testFile, initialContent);
    await tokenIndex.build();

    // 验证初始状态
    let hits = tokenIndex.findByValue("#123456");
    assert.strictEqual(hits.length, 1);

    // 模拟文件变更
    const updatedContent = `
:root {
  --updated-color: #654321;
}
		`;

    await fs.writeFile(testFile, updatedContent);
    await tokenIndex.onFileChange(testFile);

    // 验证旧值已移除
    hits = tokenIndex.findByValue("#123456");
    assert.strictEqual(hits.length, 0);

    // 验证新值已添加
    hits = tokenIndex.findByValue("#654321");
    assert.strictEqual(hits.length, 1);
    assert.strictEqual(hits[0].name, "--updated-color");
  });

  test("should not index duplicate tokens from same file", async () => {
    // 重置为默认配置（空白名单）
    vscode.workspace.getConfiguration = (section?: string) => {
      if (section === "css-value2design-token") {
        return {
          get: (key: string) => mockConfig[key as keyof typeof mockConfig],
          has: () => true,
          inspect: () => undefined,
          update: () => Promise.resolve(),
        } as any;
      }
      return originalGetConfiguration(section);
    };

    tokenIndex = new TokenIndex();

    const cssContent = `
:root {
  --primary: #2563eb;
}

html {
  --primary: #2563eb;
}
		`;

    const testFile = path.join(tempDir, "test-duplicates.css");
    await fs.writeFile(testFile, cssContent);

    await tokenIndex.build();

    const hits = tokenIndex.findByValue("#2563eb");
    assert.strictEqual(hits.length, 2); // 应该有两个不同的条目（不同选择器）

    const selectors = hits.map((h) => h.selector).sort();
    assert.deepStrictEqual(selectors, [":root", "html"]);
  });

  test("should normalize different color formats to same value", async () => {
    const cssContent = `
:root {
  --color-hex: #3b82f6;
  --color-rgb: rgb(59, 130, 246);
}
		`;

    const testFile = path.join(tempDir, "test-normalize.css");
    await fs.writeFile(testFile, cssContent);

    await tokenIndex.build();

    // 测试十六进制颜色
    const hexHits = tokenIndex.findByValue("#3b82f6");
    assert.ok(hexHits.length >= 1, "Should find hex color");
    assert.strictEqual(hexHits[0].name, "--color-hex");

    // 测试RGB颜色 - RGB会被归一化为rgb(59,130,246)格式
    const rgbHits = tokenIndex.findByValue("rgb(59,130,246)");
    assert.ok(rgbHits.length >= 1, "Should find RGB color");
    assert.strictEqual(rgbHits[0].name, "--color-rgb");
  });

  test("should parse var() references correctly", async () => {
    const cssContent = `
:root {
  --neutral-4: #cccccc;
  --color-neutral-4: var(--neutral-4);
  --spacing-base: 16px;
  --spacing-large: var(--spacing-base);
  --color-primary-with-fallback: var(--primary, #1e40af);
}
		`;

    const testFile = path.join(tempDir, "test-var-references.css");
    await fs.writeFile(testFile, cssContent);

    await tokenIndex.build();

    // 测试基本的 var() 引用
    const neutralHits = tokenIndex.findByValue("var(--neutral-4)");
    assert.strictEqual(neutralHits.length, 1, "应该找到 var(--neutral-4) 引用");
    assert.strictEqual(neutralHits[0].name, "--color-neutral-4");
    assert.strictEqual(neutralHits[0].value, "var(--neutral-4)");
    assert.strictEqual(neutralHits[0].referencedVar, "--neutral-4", "应该提取被引用的变量名");

    // 测试另一个 var() 引用
    const spacingHits = tokenIndex.findByValue("var(--spacing-base)");
    assert.strictEqual(spacingHits.length, 1, "应该找到 var(--spacing-base) 引用");
    assert.strictEqual(spacingHits[0].name, "--spacing-large");
    assert.strictEqual(spacingHits[0].referencedVar, "--spacing-base");

    // 测试带 fallback 的 var() 引用
    const fallbackHits = tokenIndex.findByValue("var(--primary)");
    assert.strictEqual(fallbackHits.length, 1, "应该找到带 fallback 的 var() 引用");
    assert.strictEqual(fallbackHits[0].name, "--color-primary-with-fallback");
    assert.strictEqual(fallbackHits[0].referencedVar, "--primary", "应该提取第一个变量名，忽略 fallback");

    // 测试原始颜色值仍然可以被找到
    const colorHits = tokenIndex.findByValue("#cccccc");
    assert.strictEqual(colorHits.length, 1);
    assert.strictEqual(colorHits[0].name, "--neutral-4");
    assert.strictEqual(colorHits[0].referencedVar, undefined, "直接值不应该有 referencedVar");

    // 测试原始尺寸值仍然可以被找到
    const sizeHits = tokenIndex.findByValue("16px");
    assert.strictEqual(sizeHits.length, 1);
    assert.strictEqual(sizeHits[0].name, "--spacing-base");
    assert.strictEqual(sizeHits[0].referencedVar, undefined);
  });

  test("should index tokens from @theme inline at-rule", async () => {
    const cssContent = `
:root {
  --green-4: #78c49c;
  --neutral-4: #edf0f2;
}

@theme inline {
  --color-green-4: var(--green-4);
  --color-neutral-4: var(--neutral-4);
}
		`;

    const testFile = path.join(tempDir, "test-theme-inline.css");
    await fs.writeFile(testFile, cssContent);

    await tokenIndex.build();

    // 测试 @theme inline 中的 var() 引用
    const greenVarHits = tokenIndex.findByValue("var(--green-4)");
    assert.strictEqual(greenVarHits.length, 1, "应该找到 var(--green-4) 引用");
    assert.strictEqual(greenVarHits[0].name, "--color-green-4");
    assert.strictEqual(greenVarHits[0].selector, "theme inline");
    assert.strictEqual(greenVarHits[0].source, "theme");
    assert.strictEqual(greenVarHits[0].referencedVar, "--green-4");

    const neutralVarHits = tokenIndex.findByValue("var(--neutral-4)");
    assert.strictEqual(neutralVarHits.length, 1, "应该找到 var(--neutral-4) 引用");
    assert.strictEqual(neutralVarHits[0].name, "--color-neutral-4");
    assert.strictEqual(neutralVarHits[0].selector, "theme inline");
    assert.strictEqual(neutralVarHits[0].source, "theme");
    assert.strictEqual(neutralVarHits[0].referencedVar, "--neutral-4");

    // 测试原始颜色值可以被找到
    const greenColorHits = tokenIndex.findByValue("#78c49c");
    assert.strictEqual(greenColorHits.length, 1);
    assert.strictEqual(greenColorHits[0].name, "--green-4");
    assert.strictEqual(greenColorHits[0].selector, ":root");
    assert.strictEqual(greenColorHits[0].source, "root");
    assert.strictEqual(greenColorHits[0].referencedVar, undefined);

    const neutralColorHits = tokenIndex.findByValue("#edf0f2");
    assert.strictEqual(neutralColorHits.length, 1);
    assert.strictEqual(neutralColorHits[0].name, "--neutral-4");
    assert.strictEqual(neutralColorHits[0].selector, ":root");
    assert.strictEqual(neutralColorHits[0].source, "root");
  });

  test("should support both @theme and @theme inline", async () => {
    const cssContent = `
@theme {
  --base-color: #1e40af;
}

@theme inline {
  --color-primary: var(--base-color);
}
		`;

    const testFile = path.join(tempDir, "test-theme-both.css");
    await fs.writeFile(testFile, cssContent);

    await tokenIndex.build();

    // 测试 @theme
    const baseHits = tokenIndex.findByValue("#1e40af");
    assert.strictEqual(baseHits.length, 1);
    assert.strictEqual(baseHits[0].name, "--base-color");
    assert.strictEqual(baseHits[0].selector, "theme");
    assert.strictEqual(baseHits[0].source, "theme");

    // 测试 @theme inline
    const primaryHits = tokenIndex.findByValue("var(--base-color)");
    assert.strictEqual(primaryHits.length, 1);
    assert.strictEqual(primaryHits[0].name, "--color-primary");
    assert.strictEqual(primaryHits[0].selector, "theme inline");
    assert.strictEqual(primaryHits[0].source, "theme");
    assert.strictEqual(primaryHits[0].referencedVar, "--base-color");
  });

  test("should find tokens by referenced variable name", async () => {
    const cssContent = `
:root {
  --neutral-4: #edf0f2;
  --green-4: #78c49c;
}

@theme inline {
  --color-neutral-4: var(--neutral-4);
  --color-green-4: var(--green-4);
}
		`;

    const testFile = path.join(tempDir, "test-find-by-ref.css");
    await fs.writeFile(testFile, cssContent);

    await tokenIndex.build();

    // 测试根据引用的变量名查找
    const neutral4Refs = tokenIndex.findByReferencedVar("--neutral-4");
    assert.strictEqual(neutral4Refs.length, 1, "应该找到 1 个引用 --neutral-4 的变量");
    assert.strictEqual(neutral4Refs[0].name, "--color-neutral-4");
    assert.strictEqual(neutral4Refs[0].referencedVar, "--neutral-4");

    const green4Refs = tokenIndex.findByReferencedVar("--green-4");
    assert.strictEqual(green4Refs.length, 1, "应该找到 1 个引用 --green-4 的变量");
    assert.strictEqual(green4Refs[0].name, "--color-green-4");
    assert.strictEqual(green4Refs[0].referencedVar, "--green-4");

    // 测试查找不存在的引用
    const nonExistentRefs = tokenIndex.findByReferencedVar("--non-existent");
    assert.strictEqual(nonExistentRefs.length, 0, "不应该找到不存在的引用");
  });

  test("should support chained lookup - find both direct and referenced tokens", async () => {
    const cssContent = `
:root {
  --neutral-4: #edf0f2;
}

@theme inline {
  --color-neutral-4: var(--neutral-4);
  --bg-neutral-4: var(--neutral-4);
}
		`;

    const testFile = path.join(tempDir, "test-chained-lookup.css");
    await fs.writeFile(testFile, cssContent);

    await tokenIndex.build();

    // 模拟链式查找：选中 #edf0f2 时，应该能找到所有相关的 token
    // 1. 直接匹配：--neutral-4
    const directHits = tokenIndex.findByValue("#edf0f2");
    assert.strictEqual(directHits.length, 1, "应该找到 1 个直接匹配的变量");
    assert.strictEqual(directHits[0].name, "--neutral-4");

    // 2. 链式查找：所有引用 --neutral-4 的变量
    const referencedHits = tokenIndex.findByReferencedVar("--neutral-4");
    assert.strictEqual(referencedHits.length, 2, "应该找到 2 个引用 --neutral-4 的变量");
    
    const refNames = referencedHits.map(h => h.name).sort();
    assert.deepStrictEqual(refNames, ["--bg-neutral-4", "--color-neutral-4"]);

    // 3. 合并结果
    const allHits = [...directHits, ...referencedHits];
    assert.strictEqual(allHits.length, 3, "总共应该找到 3 个相关的变量");
  });

  test("should support @rm-prefix to auto-generate aliases", async () => {
    // 注意：注释必须紧邻声明，中间不能有空行
    const cssContent = `:root {
  /* @rm-prefix radius */
  --radius-size-test: 7px;
}`;

    const testFile = path.join(tempDir, "test-rm-prefix.css");
    await fs.writeFile(testFile, cssContent);

    await tokenIndex.build();

    // 测试 @rm-prefix radius
    const sizeTest = tokenIndex.findByValue("7px");
    assert.strictEqual(sizeTest.length, 1, `应该找到 1 个 7px 的 token，但实际找到 ${sizeTest.length} 个`);
    assert.strictEqual(sizeTest[0].name, "--radius-size-test");
    assert.strictEqual(sizeTest[0].alias, "size-test", "别名应该是 size-test（去掉 radius- 前缀）");
  });

  test("should support @rm-prefix with pattern", async () => {
    const cssContent = `:root {
  /* @rm-prefix radius [%] */
  --radius-size-s: 8px;
  /* @rm-prefix color [%] */
  --color-primary-500: #1e40af;
}`;

    const testFile = path.join(tempDir, "test-rm-prefix-pattern.css");
    await fs.writeFile(testFile, cssContent);

    await tokenIndex.build();

    // 测试 @rm-prefix radius [%]
    const sizeS = tokenIndex.findByValue("8px");
    assert.strictEqual(sizeS.length, 1);
    assert.strictEqual(sizeS[0].name, "--radius-size-s");
    assert.strictEqual(sizeS[0].alias, "size-s", "别名应该是 size-s");
    assert.strictEqual(sizeS[0].pattern, "[%]", "模式应该是 [%]");

    // 测试 @rm-prefix color [%]
    const primary = tokenIndex.findByValue("#1e40af");
    assert.strictEqual(primary.length, 1);
    assert.strictEqual(primary[0].name, "--color-primary-500");
    assert.strictEqual(primary[0].alias, "primary-500", "别名应该是 primary-500");
    assert.strictEqual(primary[0].pattern, "[%]", "模式应该是 [%]");
  });

  test("should prioritize @alias over @rm-prefix", async () => {
    const cssContent = `:root {
  /* @rm-prefix radius */
  /* @alias custom-name */
  --radius-size-l: 16px;
}`;

    const testFile = path.join(tempDir, "test-alias-priority.css");
    await fs.writeFile(testFile, cssContent);

    await tokenIndex.build();

    const hits = tokenIndex.findByValue("16px");
    assert.strictEqual(hits.length, 1);
    assert.strictEqual(hits[0].name, "--radius-size-l");
    assert.strictEqual(hits[0].alias, "custom-name", "应该优先使用 @alias 而不是 @rm-prefix");
  });

  test("should handle @rm-prefix with trailing dash", async () => {
    const cssContent = `:root {
  /* @rm-prefix radius- */
  --radius-size-xl: 20px;
}`;

    const testFile = path.join(tempDir, "test-rm-prefix-dash.css");
    await fs.writeFile(testFile, cssContent);

    await tokenIndex.build();

    const hits = tokenIndex.findByValue("20px");
    assert.strictEqual(hits.length, 1);
    assert.strictEqual(hits[0].name, "--radius-size-xl");
    assert.strictEqual(hits[0].alias, "size-xl", "别名应该正确处理带 - 的前缀");
  });
});
