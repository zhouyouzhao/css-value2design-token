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
        
        // 为每个token创建item，并添加跳转按钮
        quickPick.items = hits.map((h) => ({
          label: h.name,
          description: vscode.workspace.asRelativePath(h.file),
          detail: h.value,
          buttons: [{
            iconPath: new vscode.ThemeIcon('go-to-file'),
            tooltip: '跳转到定义'
          }],
          tokenHit: h
        } as any));

        quickPick.placeholder = `匹配到 ${hits.length} 个 Token (回车替换，点击图标跳转到定义)`;

        // 处理选择（回车）- 替换
        quickPick.onDidAccept(() => {
          const selected = quickPick.activeItems[0] as any;
          if (selected) {
            quickPick.hide();
            editor.edit((edit) =>
              edit.replace(range, replaceWithVar(selected.label)),
            );
          }
        });

        // 处理按钮点击 - 跳转
        quickPick.onDidTriggerItemButton(async (e) => {
          const item = e.item as any;
          quickPick.hide();
          await jumpToTokenDefinition(item.tokenHit);
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
