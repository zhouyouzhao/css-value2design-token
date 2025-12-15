// src/lib/indexer.ts
import * as vscode from 'vscode';
import * as fs from 'node:fs/promises';
import { glob } from 'glob';
import * as csstree from 'css-tree';
import type { CssNode, Rule, Atrule, Declaration } from 'css-tree';
import { normalizeCssValue } from './normalize';

export type TokenHit = {
  name: string;          // --color-primary
  value: string;         // 原始值（如 #1E90FF 或 var(--neutral-4)）
  file: string;          // 文件绝对路径
  offset: number;        // 在文件中的字符偏移（用于跳转到定义）
  selector?: string;     // 来源选择器，如 ':root' / 'html' / '[data-theme=dark]' / 'theme'
  source?: 'theme' | 'root' | 'scoped';
  alias?: string;        // 别名，从 @alias 注释中提取
  pattern?: string;      // 替换模式，从 @pattern 注释中提取（% 代表选中的值）
  referencedVar?: string; // 如果值是 var() 引用，存储被引用的变量名（如 --neutral-4）
};

export type FileInfo = {
  path: string;          // 文件绝对路径
  comment: string;       // 文件顶部注释
  tokenCount: number;    // 文件中token的数量
  lastModified: number;  // 最后修改时间
};

export class TokenIndex {
  private map = new Map<string, TokenHit[]>(); // 归一化值 → 命中列表
  private ready = false;
  private mtimes = new Map<string, number>();  // 文件 mtime 用于简单变更检测
  private fileInfos = new Map<string, FileInfo>(); // 文件路径 → 文件信息

  isReady() { return this.ready; }

  async build() {
    this.map.clear();
    this.mtimes.clear();
    this.fileInfos.clear();
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

  /**
   * 查找引用了指定变量的所有 token
   * 例如：findByReferencedVar('--neutral-4') 会找到所有 referencedVar === '--neutral-4' 的 token
   */
  findByReferencedVar(varName: string): TokenHit[] {
    const results: TokenHit[] = [];
    for (const hits of this.map.values()) {
      for (const hit of hits) {
        if (hit.referencedVar === varName) {
          results.push(hit);
        }
      }
    }
    return results;
  }

  getAllIndexedFiles(): string[] {
    return Array.from(this.mtimes.keys());
  }

  getAllFileInfos(): FileInfo[] {
    return Array.from(this.fileInfos.values());
  }

  getFileInfo(filePath: string): FileInfo | undefined {
    return this.fileInfos.get(filePath);
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

  private getClassWhitelist(): RegExp[] {
    const cfg = vscode.workspace.getConfiguration('css-value2design-token');
    const patterns: string[] = cfg.get('index.classWhitelist') ?? [];
    return patterns.map(pattern => new RegExp(pattern));
  }

  private async removeFileEntries(file: string) {
    for (const [k, arr] of this.map) {
      const next = arr.filter(x => x.file !== file);
      if (next.length) this.map.set(k, next);
      else this.map.delete(k);
    }
    this.mtimes.delete(file);
    this.fileInfos.delete(file);
  }

  private async indexFile(file: string) {
    let css: string;
    let stat: any;
    try {
      stat = await fs.stat(file);
      const prev = this.mtimes.get(file) || 0;
      if (prev && stat.mtimeMs <= prev) return; // 无变更
      css = await fs.readFile(file, 'utf8');
      this.mtimes.set(file, stat.mtimeMs);
    } catch {
      return;
    }

    // 提取文件顶部注释
    const comment = this.extractFileComment(css);
    let tokenCount = 0;

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

    // 获取类白名单配置
    const classWhitelist = this.getClassWhitelist();

    // 深度遍历：单独处理 Atrule(@theme / @theme inline) 与 Rule(选择器规则)
    csstree.walk(ast, {
      enter: (node: CssNode) => {
        // 1) @theme {...} 或 @theme inline {...}
        if (node.type === 'Atrule' && (node as Atrule).name === 'theme') {
          const at = node as Atrule;
          if (!at.block) return;
          
          // 提取 @theme 的 prelude（如 'inline'）
          const prelude = at.prelude ? csstree.generate(at.prelude).trim() : '';
          const selector = prelude ? `theme ${prelude}` : 'theme';
          
          at.block.children?.forEach(child => {
            if (child.type === 'Declaration' && isCustomProp(child as Declaration)) {
              const { alias, pattern } = this.extractAliasAndPattern(css, child as Declaration);
              this.addHitFromDecl(child as Declaration, file, selector, alias, pattern);
              tokenCount++;
            }
            // 容错：@theme 内部嵌套选择器（极少见）
            if (child.type === 'Rule') {
              const rule = child as Rule;
              const ruleSelector = csstree.generate(rule.prelude).trim();
              if (isAllowedSelector(ruleSelector, classWhitelist)) {
                collectFromRule(rule, ruleSelector, file, css, (h) => {
                  this.addHit(h);
                  tokenCount++;
                });
              }
            }
          });
        }

        // 2) 普通规则：:root / html / [data-theme=...] / 白名单类 {...}
        if (node.type === 'Rule') {
          const rule = node as Rule;
          const selector = csstree.generate(rule.prelude).trim();
          if (isAllowedSelector(selector, classWhitelist)) {
            collectFromRule(rule, selector, file, css, (h) => {
              this.addHit(h);
              tokenCount++;
            });
          }
        }
      },
    });

    // 保存文件信息
    this.fileInfos.set(file, {
      path: file,
      comment,
      tokenCount,
      lastModified: stat.mtimeMs
    });
  }

  private addHitFromDecl(decl: Declaration, file: string, source: string, alias?: string, pattern?: string) {
    const name = decl.property;                          // 如 --color-primary
    const value = csstree.generate(decl.value).trim();   // 如 #1E90FF 或 var(--neutral-4)
    const norm = normalizeCssValue(value);               // 归一化
    if (!norm) return;

    const offset = decl.loc?.start.offset ?? 0;
    const referencedVar = extractVarReference(value);    // 提取 var() 引用
    
    // 判断 source 类型：theme / theme inline 都算 theme
    const sourceType: TokenHit['source'] = 
      source === 'theme' || source.startsWith('theme ') ? 'theme' :
      (source === ':root' || source === 'html' ? 'root' : 'scoped');
    
    const hit: TokenHit = {
      name, value, file, offset,
      selector: source,
      source: sourceType,
      alias,
      pattern,
      referencedVar
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

  private extractFileComment(css: string): string {
    // 提取文件开头的注释
    const lines = css.split('\n');
    const commentLines: string[] = [];
    let inBlockComment = false;
    let foundContent = false;

    for (const line of lines) {
      const trimmed = line.trim();
      
      // 跳过空行
      if (!trimmed) {
        if (foundContent) break;
        continue;
      }

      // 处理块注释 /* ... */
      if (trimmed.startsWith('/*')) {
        inBlockComment = true;
        foundContent = true;
        let content = trimmed.substring(2);
        if (content.endsWith('*/')) {
          content = content.substring(0, content.length - 2);
          inBlockComment = false;
        }
        commentLines.push(content.trim());
        continue;
      }

      if (inBlockComment) {
        let content = trimmed;
        if (content.endsWith('*/')) {
          content = content.substring(0, content.length - 2);
          inBlockComment = false;
        }
        commentLines.push(content.trim());
        continue;
      }

      // 处理单行注释 //
      if (trimmed.startsWith('//')) {
        foundContent = true;
        commentLines.push(trimmed.substring(2).trim());
        continue;
      }

      // 如果遇到非注释内容，停止提取
      break;
    }

    return commentLines
      .filter(line => line.length > 0)
      .join(' ')
      .substring(0, 100) // 限制长度
      .trim();
  }

  private extractAlias(css: string, decl: Declaration): string | undefined {
    const { alias } = this.extractAliasAndPattern(css, decl);
    return alias;
  }

  private extractPattern(css: string, decl: Declaration): string | undefined {
    const { pattern } = this.extractAliasAndPattern(css, decl);
    return pattern;
  }

  private extractAliasAndPattern(css: string, decl: Declaration): { alias?: string; pattern?: string } {
    // 从声明前面的注释中提取 @alias、@pattern 和 @rm-prefix
    // 支持格式：
    // 1. // @alias xl [%]  (一行，推荐)
    // 2. // @alias xl      (单独一行)
    //    // @pattern [%]   (单独一行)
    // 3. /* @rm-prefix radius [%] */ (自动生成别名，去掉指定前缀，并指定模式)
    if (!decl.loc) return {};
    
    const lines = css.split('\n');
    const declLine = decl.loc.start.line - 1; // 转换为0-based索引
    
    let alias: string | undefined;
    let pattern: string | undefined;
    let rmPrefix: string | undefined;
    let rmPrefixPattern: string | undefined;
    
    // 向上查找注释
    for (let i = declLine - 1; i >= 0; i--) {
      const line = lines[i];
      const trimmed = line.trim();
      
      // 如果遇到空行，继续向上查找
      if (!trimmed) continue;
      
      // 检查单行注释
      if (trimmed.startsWith('//')) {
        // 优先匹配新格式：// @alias xl [%]
        const combinedMatch = trimmed.match(/\/\/\s*@alias\s+(\S+)\s+(.+)/);
        if (combinedMatch && !alias) {
          alias = combinedMatch[1];
          pattern = combinedMatch[2].trim();
          continue;
        }
        
        // 兼容旧格式：// @alias xl
        const aliasMatch = trimmed.match(/\/\/\s*@alias\s+(\S+)$/);
        if (aliasMatch && !alias) {
          alias = aliasMatch[1];
          continue;
        }
        
        // 兼容旧格式：// @pattern [%]
        const patternMatch = trimmed.match(/\/\/\s*@pattern\s+(.+)/);
        if (patternMatch && !pattern) {
          pattern = patternMatch[1].trim();
          continue;
        }
        
        // 新功能：// @rm-prefix prefix-value [pattern]
        const rmPrefixMatch = trimmed.match(/\/\/\s*@rm-prefix\s+(\S+)(?:\s+(.+))?/);
        if (rmPrefixMatch && !rmPrefix) {
          rmPrefix = rmPrefixMatch[1];
          if (rmPrefixMatch[2]) {
            rmPrefixPattern = rmPrefixMatch[2].trim();
          }
          continue;
        }
        
        continue;
      }
      
      // 检查块注释
      if (trimmed.includes('@alias')) {
        // 新格式：/* @alias xl [%] */
        const combinedMatch = trimmed.match(/@alias\s+(\S+)\s+(.+?)(?:\*\/|$)/);
        if (combinedMatch && !alias) {
          alias = combinedMatch[1];
          pattern = combinedMatch[2].trim().replace(/\*\/$/, '').trim();
          continue;
        }
        
        // 旧格式：/* @alias xl */
        const aliasMatch = trimmed.match(/@alias\s+(\S+)/);
        if (aliasMatch && !alias) {
          alias = aliasMatch[1];
        }
      }
      
      if (trimmed.includes('@pattern')) {
        const patternMatch = trimmed.match(/@pattern\s+(.+?)(?:\*\/|$)/);
        if (patternMatch && !pattern) {
          pattern = patternMatch[1].trim();
        }
      }
      
      // 检查 @rm-prefix（支持带模式）
      if (trimmed.includes('@rm-prefix')) {
        const rmPrefixMatch = trimmed.match(/@rm-prefix\s+(\S+)(?:\s+(.+?))?(?:\*\/|$)/);
        if (rmPrefixMatch && !rmPrefix) {
          rmPrefix = rmPrefixMatch[1];
          if (rmPrefixMatch[2]) {
            rmPrefixPattern = rmPrefixMatch[2].trim().replace(/\*\/$/, '').trim();
          }
        }
      }
      
      // 如果是注释行，继续查找
      if (trimmed.startsWith('//') || trimmed.startsWith('/*') || trimmed.endsWith('*/') || trimmed.startsWith('*')) {
        continue;
      }
      
      // 如果遇到其他非注释内容，停止查找
      break;
    }
    
    // 如果没有显式的 @alias，但有 @rm-prefix，自动生成别名
    if (!alias && rmPrefix && decl.property) {
      alias = generateAliasFromRmPrefix(decl.property, rmPrefix);
    }
    
    // 如果 @rm-prefix 指定了 pattern，使用它
    if (rmPrefixPattern && !pattern) {
      pattern = rmPrefixPattern;
    }
    
    return { alias, pattern };
  }
}

// ---------- 辅助函数 ----------

// 允许被索引的选择器白名单：:root、html、[data-theme="..."]、以及配置的类白名单（包含组合、逗号并列）
function isAllowedSelector(selector: string, classWhitelist: RegExp[] = []): boolean {
  // 多个选择器并列时全部检查
  const parts = selector.split(',').map(s => s.trim());
  return parts.every(s =>
    /^:root(\b|$)/.test(s) ||
    /^html(\b|$)/.test(s) ||
    /\[data-theme\b/i.test(s) ||                // [data-theme] / [data-theme="dark"]
    /^html\[data-theme\b/i.test(s) ||           // html[data-theme="dark"]
    isClassAllowed(s, classWhitelist)           // 检查类白名单
  );
}

// 检查选择器是否匹配类白名单
function isClassAllowed(selector: string, classWhitelist: RegExp[]): boolean {
  if (classWhitelist.length === 0) return false;
  return classWhitelist.some(regex => regex.test(selector));
}

function isCustomProp(decl: Declaration): boolean {
  return !!decl.property && decl.property.startsWith('--');
}

function collectFromRule(rule: Rule, selector: string, file: string, css: string, add: (h: TokenHit) => void) {
  rule.block.children?.forEach(n => {
    if (n.type !== 'Declaration') return;
    const decl = n as Declaration;
    if (!isCustomProp(decl)) return;
    const name = decl.property;
    const value = csstree.generate(decl.value).trim();
    const offset = decl.loc?.start.offset ?? 0;
    const source: TokenHit['source'] =
      selector === ':root' || selector === 'html' ? 'root' : 'scoped';
    
    // 提取别名和模式
    const { alias, pattern } = extractAliasAndPatternFromDecl(css, decl);
    
    // 提取 var() 引用
    const referencedVar = extractVarReference(value);
    
    add({ name, value, file, offset, selector, source, alias, pattern, referencedVar });
  });
}

/**
 * 从 var() 函数中提取被引用的变量名
 * 例如: var(--color-primary) -> --color-primary
 *      var(--spacing-xl, 20px) -> --spacing-xl
 */
function extractVarReference(value: string): string | undefined {
  const varMatch = value.match(/^var\(\s*(--[a-zA-Z0-9-_]+)(?:\s*,\s*.*)?\s*\)$/i);
  return varMatch ? varMatch[1] : undefined;
}

/**
 * 根据 @rm-prefix 生成别名
 * 例如: --radius-size-s + "radius" -> size-s
 *      --color-primary-500 + "color" -> primary-500
 * 
 * @param varName 变量名（如 --radius-size-s）
 * @param prefix 要移除的前缀（如 radius 或 radius-）
 * @returns 生成的别名
 */
function generateAliasFromRmPrefix(varName: string, prefix: string): string {
  // 1. 移除 -- 前缀
  let result = varName.startsWith('--') ? varName.substring(2) : varName;
  
  // 2. 规范化 prefix：如果 prefix 不以 - 结尾，添加 -
  const normalizedPrefix = prefix.endsWith('-') ? prefix : prefix + '-';
  
  // 3. 如果结果以 normalizedPrefix 开头，移除它
  if (result.startsWith(normalizedPrefix)) {
    result = result.substring(normalizedPrefix.length);
  }
  
  return result;
}

function extractAliasAndPatternFromDecl(css: string, decl: Declaration): { alias?: string; pattern?: string } {
  // 从声明前面的注释中提取 @alias、@pattern 和 @rm-prefix
  // 支持格式：
  // 1. // @alias xl [%]  (一行，推荐)
  // 2. // @alias xl      (单独一行)
  //    // @pattern [%]   (单独一行)
  // 3. /* @rm-prefix radius [%] */ (自动生成别名，去掉指定前缀，并指定模式)
  if (!decl.loc) return {};
  
  const lines = css.split('\n');
  const declLine = decl.loc.start.line - 1; // 转换为0-based索引
  
  let alias: string | undefined;
  let pattern: string | undefined;
  let rmPrefix: string | undefined;
  let rmPrefixPattern: string | undefined;
  
  // 向上查找注释
  for (let i = declLine - 1; i >= 0; i--) {
    const line = lines[i];
    const trimmed = line.trim();
    
    // 如果遇到空行，继续向上查找
    if (!trimmed) continue;
    
    // 检查单行注释
    if (trimmed.startsWith('//')) {
      // 优先匹配新格式：// @alias xl [%]
      const combinedMatch = trimmed.match(/\/\/\s*@alias\s+(\S+)\s+(.+)/);
      if (combinedMatch && !alias) {
        alias = combinedMatch[1];
        pattern = combinedMatch[2].trim();
        continue;
      }
      
      // 兼容旧格式：// @alias xl
      const aliasMatch = trimmed.match(/\/\/\s*@alias\s+(\S+)$/);
      if (aliasMatch && !alias) {
        alias = aliasMatch[1];
        continue;
      }
      
      // 兼容旧格式：// @pattern [%]
      const patternMatch = trimmed.match(/\/\/\s*@pattern\s+(.+)/);
      if (patternMatch && !pattern) {
        pattern = patternMatch[1].trim();
        continue;
      }
      
      // 新功能：// @rm-prefix prefix-value [pattern]
      const rmPrefixMatch = trimmed.match(/\/\/\s*@rm-prefix\s+(\S+)(?:\s+(.+))?/);
      if (rmPrefixMatch && !rmPrefix) {
        rmPrefix = rmPrefixMatch[1];
        if (rmPrefixMatch[2]) {
          rmPrefixPattern = rmPrefixMatch[2].trim();
        }
        continue;
      }
      
      continue;
    }
    
    // 检查块注释
    if (trimmed.includes('@alias')) {
      // 新格式：/* @alias xl [%] */
      const combinedMatch = trimmed.match(/@alias\s+(\S+)\s+(.+?)(?:\*\/|$)/);
      if (combinedMatch && !alias) {
        alias = combinedMatch[1];
        pattern = combinedMatch[2].trim().replace(/\*\/$/, '').trim();
        continue;
      }
      
      // 旧格式：/* @alias xl */
      const aliasMatch = trimmed.match(/@alias\s+(\S+)/);
      if (aliasMatch && !alias) {
        alias = aliasMatch[1];
      }
    }
    
    if (trimmed.includes('@pattern')) {
      const patternMatch = trimmed.match(/@pattern\s+(.+?)(?:\*\/|$)/);
      if (patternMatch && !pattern) {
        pattern = patternMatch[1].trim();
      }
    }
    
    // 检查 @rm-prefix（支持带模式）
    if (trimmed.includes('@rm-prefix')) {
      const rmPrefixMatch = trimmed.match(/@rm-prefix\s+(\S+)(?:\s+(.+?))?(?:\*\/|$)/);
      if (rmPrefixMatch && !rmPrefix) {
        rmPrefix = rmPrefixMatch[1];
        if (rmPrefixMatch[2]) {
          rmPrefixPattern = rmPrefixMatch[2].trim().replace(/\*\/$/, '').trim();
        }
      }
    }
    
    // 如果是注释行，继续查找
    if (trimmed.startsWith('//') || trimmed.startsWith('/*') || trimmed.endsWith('*/') || trimmed.startsWith('*')) {
      continue;
    }
    
    // 如果遇到其他非注释内容，停止查找
    break;
  }
  
  // 如果没有显式的 @alias，但有 @rm-prefix，自动生成别名
  if (!alias && rmPrefix && decl.property) {
    alias = generateAliasFromRmPrefix(decl.property, rmPrefix);
  }
  
  // 如果 @rm-prefix 指定了 pattern，使用它
  if (rmPrefixPattern && !pattern) {
    pattern = rmPrefixPattern;
  }
  
  return { alias, pattern };
}
