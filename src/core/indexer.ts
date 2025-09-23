import * as vscode from "vscode";
import * as fs from "node:fs/promises";
import { glob } from "glob";
import csstree, { CssNode, Rule, Atrule, Declaration } from "css-tree";
import { normalizeCssValue } from "./normalize";

export type TokenHit = {
  name: string;
  value: string;
  file: string;
  offset: number;
  selector?: string;
  source?: "theme" | "root" | "scoped";
};

export class TokenIndex {
  private map = new Map<string, TokenHit[]>();
  private ready = false;

  isReady() {
    return this.ready;
  }

  async build() {
    this.map.clear();
    const files = await this.resolveSources();
    for (const f of files) await this.indexFile(f);
    this.ready = true;
  }

  async onFileChange(file: string) {
    // 简单策略：重建该文件相关条目
    await this.removeFileEntries(file);
    await this.indexFile(file);
  }

  findByValue(norm: string): TokenHit[] {
    return this.map.get(norm) ?? [];
  }

  // ------------ internals -------------
  private async resolveSources(): Promise<string[]> {
    const cfg = vscode.workspace.getConfiguration("css-value2design-token");
    const patterns: string[] = cfg.get("sources") ?? [];
    const roots =
      vscode.workspace.workspaceFolders?.map((f) => f.uri.fsPath) ?? [];
    const set = new Set<string>();
    for (const root of roots) {
      for (const pat of patterns) {
        for (const m of await glob(pat, { cwd: root, absolute: true }))
          set.add(m);
      }
    }
    return [...set];
  }

  private async removeFileEntries(file: string) {
    for (const [k, arr] of this.map) {
      const next = arr.filter((x) => x.file !== file);
      if (next.length) this.map.set(k, next);
      else this.map.delete(k);
    }
  }

  private async indexFile(file: string) {
    let css: string;
    try {
      css = await fs.readFile(file, "utf8");
    } catch {
      return;
    }

    let ast;
    try {
      ast = csstree.parse(css, {
        positions: true,
        parseCustomProperty: true,
        filename: file,
      });
    } catch {
      // 解析失败直接跳过该文件
      return;
    }

    // 遍历 AST，收集 @theme 块、:root/html/[data-theme] 规则中的自定义属性
    csstree.walk(ast, {
      visit: "Rule", // 规则（选择器）
      enter: (node: CssNode, item, list) => {
        if (node.type === "Atrule") {
          const at = node as Atrule;
          if (isThemeAtrule(at)) {
            collectFromAtruleBlock(at, file, css, this.addHit);
          } else if (
            at.name === "media" ||
            at.name === "supports" ||
            at.name === "layer"
          ) {
            // 这些里面也可能嵌有 :root 等，继续让 walker 下钻
          }
        } else if (node.type === "Rule") {
          const rule = node as Rule;
          const selector = csstree.generate(rule.prelude).trim();
          if (isAllowedSelector(selector)) {
            collectFromRule(rule, selector, file, css, this.addHit);
          }
        }
      },
    });
  }

  private addHit = (hit: TokenHit) => {
    const norm = normalizeCssValue(hit.value);
    if (!norm) return;
    const arr = this.map.get(norm) ?? [];
    if (
      !arr.some(
        (x) =>
          x.file === hit.file && x.name === hit.name && x.offset === hit.offset,
      )
    ) {
      arr.push(hit);
      this.map.set(norm, arr);
    }
  };
}

// ---------- helpers ----------

// 判断 @theme（Tailwind v4）
function isThemeAtrule(at: Atrule): boolean {
  return at.name === "theme";
}

function isAllowedSelector(selector: string): boolean {
  // 可按需扩展白名单
  // :root、html、[data-theme="..."] 及其逗号并列形式
  // 也允许类似 html[data-theme="dark"]
  const parts = selector.split(",").map((s) => s.trim());
  return parts.every(
    (s) =>
      /^:root\b/.test(s) ||
      /^html\b/.test(s) ||
      /^\[data-theme(?:=|~|\^|\$|\*|\|)?/i.test(s) ||
      /^html\[data-theme/i.test(s),
  );
}

function collectFromAtruleBlock(
  at: Atrule,
  file: string,
  css: string,
  add: (h: TokenHit) => void,
) {
  if (!at.block) return;
  at.block.children?.forEach((child) => {
    if (child.type === "Declaration") {
      const decl = child as Declaration;
      if (!isCustomProp(decl)) return;
      const name = getPropName(decl);
      const value = getValueRaw(decl);
      const offset = decl.loc?.start.offset ?? 0;
      add({ name, value, file, offset, source: "theme" });
    } else if (child.type === "Rule") {
      // 允许 @theme 内部再嵌套（极少见，但容错）
      const selector = csstree.generate(child.prelude).trim();
      if (isAllowedSelector(selector))
        collectFromRule(child, selector, file, css, add);
    }
  });
}

function collectFromRule(
  rule: Rule,
  selector: string,
  file: string,
  css: string,
  add: (h: TokenHit) => void,
) {
  rule.block.children?.forEach((n) => {
    if (n.type !== "Declaration") return;
    const decl = n as Declaration;
    if (!isCustomProp(decl)) return;
    const name = getPropName(decl);
    const value = getValueRaw(decl);
    const offset = decl.loc?.start.offset ?? 0;
    const source =
      selector === ":root" || selector === "html" ? "root" : "scoped";
    add({ name, value, file, offset, selector, source });
  });
}

function isCustomProp(decl: Declaration) {
  return decl.property.startsWith("--");
}
function getPropName(decl: Declaration) {
  return decl.property; // 已含 --
}
function getValueRaw(decl: Declaration) {
  // 用 csstree 生成标准字符串；比直接 slice 文本更稳
  return csstree.generate(decl.value).trim();
}
