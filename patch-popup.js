const fs = require("fs");
const jsPath = "D:/tmp/deploy-system/public/app.js";
const cssPath = "D:/tmp/deploy-system/public/style.css";
let js = fs.readFileSync(jsPath, "utf8");
const viewAction = `{ label: "查看命令", run: () => openViewer({ title: "完整命令", kicker: "查看", sub: "", badge: "", log: (ownSteps[index] || step).command || step.preview || step.command || "" }) },
          { label: "编辑命令", run: () => editStep(ownSteps[index] || step) },
          `;
if (!js.includes("查看命令")) {
  js = js.replace(
    '{ label: "删除这条命令", run: () => deleteCommand(ownSteps[index] || step) },',
    viewAction + '{ label: "删除这条命令", run: () => deleteCommand(ownSteps[index] || step) },'
  );
  js = js.replace(
    '{ label: "删除这条命令", run: () => deleteCommand(step) },',
    `{ label: "查看命令", run: () => openViewer({ title: "完整命令", kicker: "查看", sub: "", badge: "", log: step.command || "" }) },
          { label: "编辑命令", run: () => editStep(step) },
          { label: "删除这条命令", run: () => deleteCommand(step) },`
  );
}
fs.writeFileSync(jsPath, js);
let css = fs.readFileSync(cssPath, "utf8");
if (!css.includes("text-overflow: ellipsis")) {
  css = css.replace(
    ".title { font-weight: 720; margin-top: 3px; line-height: 1.35; }",
    ".title { font-weight: 720; margin-top: 3px; line-height: 1.35; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }"
  );
  fs.writeFileSync(cssPath, css);
}
const root = "C:/Users/jiuzhou/Documents/Codex/2026-10-29/new-chat-3/deploy-system/public";
fs.copyFileSync(jsPath, root + "/app.js");
fs.copyFileSync(cssPath, root + "/style.css");
console.log("ok");
