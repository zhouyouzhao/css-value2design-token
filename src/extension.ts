import * as vscode from "vscode";

export function activate(context: vscode.ExtensionContext) {
  console.log(
    'Congratulations, your extension "css-value2design-token" is now active!',
  );

  const disposable = vscode.commands.registerCommand(
    "css-value2design-token.findAndReplace",
    () => {
      const editor = vscode.window.activeTextEditor;
      const txt = editor ? editor.document.getText(editor.selection) : "";
      vscode.window.showInformationMessage(
        `Find Design Token triggered. Selected: "${txt}"`,
      );
    },
  );

  context.subscriptions.push(disposable);
}

// This method is called when your extension is deactivated
export function deactivate() {}
