// src/extension.ts（片段）
import * as vscode from "vscode";
import { TokenIndex } from "./core/indexer";
import { normalizeCssValue } from "./core/normalize";
import { replaceWithVar } from "./core/replace";
console.log("extension.ts");

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
          vscode.window.showInformationMessage("未找到匹配的 design token");
          return;
        }

        const pick = await vscode.window.showQuickPick(
          hits.map((h) => ({
            label: h.name, // --color-primary
            description: h.file, // src/app.css
            detail: h.value, // #1E90FF（原始值）
          })),
          { placeHolder: `匹配到 ${hits.length} 个 Token` },
        );
        if (!pick) return;

        await editor.edit((edit) =>
          edit.replace(range, replaceWithVar(pick.label)),
        );
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
