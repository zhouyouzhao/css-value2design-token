// src/lib/indexer.ts
import * as vscode from 'vscode';
import * as fs from 'node:fs/promises';
import { glob } from 'glob';
import * as csstree from 'css-tree';
import type { CssNode, Rule, Atrule, Declaration } from 'css-tree';
import { normalizeCssValue } from './normalize';

export type TokenHit = {
  name: string;          // --color-primary
  value: string;         // 原始值（如 #1E90FF）
  file: string;          // 文件绝对路径
  offset: number;        // 在文件中的字符偏移（用于跳转到定义）
  selector?: string;     // 来源选择器，如 ':root' / 'html' / '[data-theme=dark]' / 'theme'
  source?: 'theme' | 'root' | 'scoped';
};

export class TokenIndex {
  private map = new Map<string, TokenHit[]>(); // 归一化值 → 命中列表
  private ready = false;
  private mtimes = new Map<string, number>();  // 文件 mtime 用于简单变更检测

  isReady() { return this.ready; }

  async build() {
    this.map.clear();
    this.mtimes.clear();
    const files = await this.resolveSources();
    for (const f of files) await this.indexFile(f);
    this.ready = true;
  }

  async onFileChange(file: string) {
    // 简单增量：仅重建该文件的条目
    await this.removeFileEntries(file);
    await this.indexFile(file);
  }

  findByValue(normalized: string): TokenHit[] {
    return this.map.get(normalized) ?? [];
  }

  // ---------- 内部实现 ----------

  private async resolveSources(): Promise<string[]> {
    const cfg = vscode.workspace.getConfiguration('css-value2design-token');
    const patterns: string[] = cfg.get('sources') ?? [];
    const roots = vscode.workspace.workspaceFolders?.map(f => f.uri.fsPath) ?? [];
    const set = new Set<string>();
    for (const root of roots) {
      for (const pat of patterns) {
        const matches = await glob(pat, { cwd: root, absolute: true, nodir: true });
        matches.forEach(m => set.add(m));
      }
    }
    return [...set];
  }

  private async removeFileEntries(file: string) {
    for (const [k, arr] of this.map) {
      const next = arr.filter(x => x.file !== file);
      if (next.length) this.map.set(k, next);
      else this.map.delete(k);
    }
    this.mtimes.delete(file);
  }

  private async indexFile(file: string) {
    let css: string;
    try {
      const st = await fs.stat(file);
      const prev = this.mtimes.get(file) || 0;
      if (prev && st.mtimeMs <= prev) return; // 无变更
      css = await fs.readFile(file, 'utf8');
      this.mtimes.set(file, st.mtimeMs);
    } catch {
      return;
    }

    let ast: csstree.CssNode;
    try {
      ast = csstree.parse(css, {
        positions: true,
        parseCustomProperty: true,
        filename: file,
      });
    } catch {
      // 语法错误时跳过该文件
      return;
    }

    // 深度遍历：单独处理 Atrule(@theme) 与 Rule(选择器规则)
    csstree.walk(ast, {
      enter: (node: CssNode) => {
        // 1) @theme {...}
        if (node.type === 'Atrule' && (node as Atrule).name === 'theme') {
          const at = node as Atrule;
          if (!at.block) return;
          at.block.children?.forEach(child => {
            if (child.type === 'Declaration' && isCustomProp(child as Declaration)) {
              this.addHitFromDecl(child as Declaration, file, 'theme');
            }
            // 容错：@theme 内部嵌套选择器（极少见）
            if (child.type === 'Rule') {
              const rule = child as Rule;
              const selector = csstree.generate(rule.prelude).trim();
              if (isAllowedSelector(selector)) {
                collectFromRule(rule, selector, file, (h) => this.addHit(h));
              }
            }
          });
        }

        // 2) 普通规则：:root / html / [data-theme=...] {...}
        if (node.type === 'Rule') {
          const rule = node as Rule;
          const selector = csstree.generate(rule.prelude).trim();
          if (isAllowedSelector(selector)) {
            collectFromRule(rule, selector, file, (h) => this.addHit(h));
          }
        }
      },
    });
  }

  private addHitFromDecl(decl: Declaration, file: string, source: string) {
    const name = decl.property;                          // 如 --color-primary
    const value = csstree.generate(decl.value).trim();   // 如 #1E90FF
    const norm = normalizeCssValue(value);               // 归一化
    if (!norm) return;

    const offset = decl.loc?.start.offset ?? 0;
    const hit: TokenHit = {
      name, value, file, offset,
      selector: source,
      source: source === 'theme' ? 'theme' : (source === ':root' || source === 'html' ? 'root' : 'scoped')
    };

    const arr = this.map.get(norm) ?? [];
    if (!arr.some(x => x.file === hit.file && x.name === hit.name && x.offset === hit.offset)) {
      arr.push(hit);
      this.map.set(norm, arr);
    }
  }

  private addHit(hit: TokenHit) {
    const norm = normalizeCssValue(hit.value);
    if (!norm) return;
    const arr = this.map.get(norm) ?? [];
    if (!arr.some(x => x.file === hit.file && x.name === hit.name && x.offset === hit.offset)) {
      arr.push(hit);
      this.map.set(norm, arr);
    }
  }
}

// ---------- 辅助函数 ----------

// 允许被索引的选择器白名单：:root、html、[data-theme="..."]（包含组合、逗号并列）
function isAllowedSelector(selector: string): boolean {
  // 多个选择器并列时全部检查
  const parts = selector.split(',').map(s => s.trim());
  return parts.every(s =>
    /^:root(\b|$)/.test(s) ||
    /^html(\b|$)/.test(s) ||
    /\[data-theme\b/i.test(s) ||                // [data-theme] / [data-theme="dark"]
    /^html\[data-theme\b/i.test(s)              // html[data-theme="dark"]
  );
}

function isCustomProp(decl: Declaration): boolean {
  return !!decl.property && decl.property.startsWith('--');
}

function collectFromRule(rule: Rule, selector: string, file: string, add: (h: TokenHit) => void) {
  rule.block.children?.forEach(n => {
    if (n.type !== 'Declaration') return;
    const decl = n as Declaration;
    if (!isCustomProp(decl)) return;
    const name = decl.property;
    const value = csstree.generate(decl.value).trim();
    const offset = decl.loc?.start.offset ?? 0;
    const source: TokenHit['source'] =
      selector === ':root' || selector === 'html' ? 'root' : 'scoped';
    add({ name, value, file, offset, selector, source });
  });
}
