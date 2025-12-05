// src/extension.ts（片段）
import * as vscode from "vscode";
import { TokenIndex, TokenHit, FileInfo } from "./core/indexer";
import { normalizeCssValue } from "./core/normalize";
import { replaceWithVar } from "./core/replace";

let index = new TokenIndex();

export async function activate(ctx: vscode.ExtensionContext) {
  // 文件变更时尝试增量刷新
  ctx.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument((doc) => {
      if (doc.languageId === "css" || /\.pcss$/i.test(doc.fileName)) {
        index.onFileChange(doc.fileName);
      }
    }),
  );

  ctx.subscriptions.push(
    vscode.commands.registerCommand(
      "css-value2design-token.findAndReplace",
      async () => {
        // 懒构建：首次或过期时才重建
        await ensureIndexReady();

        const editor = vscode.window.activeTextEditor;
        if (!editor) return;
        const range = editor.document.getWordRangeAtPosition(
          editor.selection.active,
          // 光标点在某个值里面但没有手动选中内容，自动选中整个值
          /[#\w\-\(\),.%\s]+/,
        );
        if (!range) return;

        const raw = editor.document.getText(range).trim();
        const norm = normalizeCssValue(raw);
        if (!norm) {
          vscode.window.showWarningMessage("未识别到可用的 CSS 值");
          return;
        }

        const hits = index.findByValue(norm);
        if (!hits.length) {
          await showNoTokenFoundDialog();
          return;
        }

        // 创建自定义QuickPick以支持按钮
        const quickPick = vscode.window.createQuickPick();
        
        // 为每个token创建item，并添加按钮（跳转 + 别名替换）
        quickPick.items = hits.map((h) => {
          const buttons: vscode.QuickInputButton[] = [
            {
              iconPath: new vscode.ThemeIcon('go-to-file'),
              tooltip: '跳转到定义'
            }
          ];
          
          // 如果有别名，添加别名替换按钮
          if (h.alias) {
            buttons.push({
              iconPath: new vscode.ThemeIcon('symbol-keyword'),
              tooltip: `使用别名替换: ${h.alias}`
            });
          }
          
          // 构建 detail 信息
          let detail = h.value;
          if (h.alias) {
            detail += ` (别名: ${h.alias})`;
          }
          if (h.pattern) {
            detail += ` [模式: ${h.pattern}]`;
          }
          
          return {
            label: h.name,
            description: vscode.workspace.asRelativePath(h.file),
            detail,
            buttons,
            tokenHit: h
          } as any;
        });

        quickPick.placeholder = `匹配到 ${hits.length} 个 Token (回车替换为var，点击图标跳转或使用别名)`;

        // 处理选择（回车）- 替换为 var(--xxx)
        quickPick.onDidAccept(() => {
          const selected = quickPick.activeItems[0] as any;
          if (selected) {
            quickPick.hide();
            editor.edit((edit) =>
              edit.replace(range, replaceWithVar(selected.label)),
            );
          }
        });

        // 处理按钮点击
        quickPick.onDidTriggerItemButton(async (e) => {
          const item = e.item as any;
          const buttonIndex = item.buttons.indexOf(e.button);
          
          quickPick.hide();
          
          // 第一个按钮：跳转到定义
          if (buttonIndex === 0) {
            await jumpToTokenDefinition(item.tokenHit);
          }
          // 第二个按钮：使用别名替换
          else if (buttonIndex === 1 && item.tokenHit.alias) {
            // 根据 pattern 扩展替换范围
            const expandedRange = getExpandedRangeByPattern(
              editor.document, 
              range, 
              item.tokenHit.pattern
            );
            editor.edit((edit) =>
              edit.replace(expandedRange, item.tokenHit.alias),
            );
          }
        });

        quickPick.onDidHide(() => quickPick.dispose());
        quickPick.show();
      },
    ),
  );
}

async function ensureIndexReady() {
  if (index.isReady()) return;
  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Window, title: "索引 design tokens…" },
    async () => {
      await index.build();
    },
  );
}

async function jumpToTokenDefinition(tokenHit: TokenHit) {
  try {
    const document = await vscode.workspace.openTextDocument(tokenHit.file);
    const position = document.positionAt(tokenHit.offset);
    const editor = await vscode.window.showTextDocument(document);
    editor.selection = new vscode.Selection(position, position);
    editor.revealRange(new vscode.Range(position, position));
  } catch (error) {
    vscode.window.showErrorMessage(`无法打开文件: ${tokenHit.file}`);
  }
}

async function showNoTokenFoundDialog() {
  const action = await vscode.window.showInformationMessage(
    "未找到匹配的 design token",
    "查看所有文件"
  );
  
  if (action === "查看所有文件") {
    await showAllIndexedFiles();
  }
}

async function showAllIndexedFiles() {
  const fileInfos = index.getAllFileInfos();
  if (!fileInfos.length) {
    vscode.window.showInformationMessage("没有找到任何已索引的文件");
    return;
  }

  const items = fileInfos.map(fileInfo => {
    const relativePath = vscode.workspace.asRelativePath(fileInfo.path);
    const tokenCountText = fileInfo.tokenCount > 0 ? `${fileInfo.tokenCount} tokens` : '无 tokens';
    const lastModified = new Date(fileInfo.lastModified).toLocaleDateString('zh-CN');
    
    return {
      label: `$(file-code) ${relativePath}`,
      description: `${tokenCountText} • ${lastModified}`,
      detail: fileInfo.comment || '无注释',
      fileInfo: fileInfo
    };
  });

  // 按token数量排序，token多的在前面
  items.sort((a, b) => b.fileInfo.tokenCount - a.fileInfo.tokenCount);

  const pick = await vscode.window.showQuickPick(items, { 
    placeHolder: `选择要打开的文件 (共 ${fileInfos.length} 个文件，${fileInfos.reduce((sum, f) => sum + f.tokenCount, 0)} 个 tokens)`,
    matchOnDescription: true,
    matchOnDetail: true
  });

  if (pick) {
    try {
      const document = await vscode.workspace.openTextDocument(pick.fileInfo.path);
      await vscode.window.showTextDocument(document);
    } catch (error) {
      vscode.window.showErrorMessage(`无法打开文件: ${pick.fileInfo.path}`);
    }
  }
}

/**
 * 根据 pattern 扩展替换范围
 * pattern 中 % 代表选中的值
 * 
 * 示例：
 * - pattern: [%]  →  text-[20px] 中选中 20px，扩展为 [20px]
 * - pattern: var(%%)  →  color: var(#1E90FF) 中选中 #1E90FF，扩展为 var(#1E90FF)
 * - 无 pattern  →  不扩展，只替换选中的值
 */
function getExpandedRangeByPattern(
  document: vscode.TextDocument,
  originalRange: vscode.Range,
  pattern?: string
): vscode.Range {
  // 如果没有 pattern，返回原始范围
  if (!pattern) {
    return originalRange;
  }
  
  const line = document.lineAt(originalRange.start.line);
  const lineText = line.text;
  const selectedText = document.getText(originalRange);
  
  // 将 pattern 转换为正则表达式
  // % 代表选中的值，需要转义其他特殊字符
  const escapedPattern = pattern
    .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')  // 转义特殊字符
    .replace(/\\%/g, '.*?');  // % 替换为非贪婪匹配
  
  // 构建正则表达式，匹配包含选中值的完整模式
  const regex = new RegExp(escapedPattern.replace('.*?', escapeRegExp(selectedText)));
  
  // 在当前行中查找匹配
  const startChar = originalRange.start.character;
  const endChar = originalRange.end.character;
  
  // 向前查找：从选中位置开始，尝试找到模式的起始位置
  const beforeText = lineText.substring(0, startChar);
  const afterText = lineText.substring(endChar);
  
  // 根据 pattern 计算前后需要包含的字符数
  const beforePattern = pattern.split('%')[0];
  const afterPattern = pattern.split('%').slice(1).join('%');
  
  let newStart = startChar;
  let newEnd = endChar;
  
  // 检查前面是否匹配
  if (beforePattern && beforeText.endsWith(beforePattern)) {
    newStart = startChar - beforePattern.length;
  }
  
  // 检查后面是否匹配
  if (afterPattern && afterText.startsWith(afterPattern)) {
    newEnd = endChar + afterPattern.length;
  }
  
  // 只有当找到完整的模式时才扩展范围
  if (newStart < startChar || newEnd > endChar) {
    return new vscode.Range(
      originalRange.start.line,
      newStart,
      originalRange.end.line,
      newEnd
    );
  }
  
  return originalRange;
}

/**
 * 转义正则表达式特殊字符
 */
function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
