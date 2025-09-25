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
});
