const fs = require("fs");
const jsPath = "D:/tmp/deploy-system/public/app.js";
const cssPath = "D:/tmp/deploy-system/public/style.css";
let js = fs.readFileSync(jsPath, "utf8");
const old = `  if (node.actions) {
    const bar = document.createElement("div");
    bar.className = "node-actions";
    for (const action of node.actions) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "zoom";
      button.textContent = action.label;
      button.onclick = (event) => {
        event.stopPropagation();
        action.run();
      };
      bar.append(button);
    }
    el.append(bar);
  }`;
const neu = `  if (node.actions) {
    const hint = document.createElement("div");
    hint.className = "node-more";
    hint.textContent = "操作";
    const bar = document.createElement("div");
    bar.className = "node-actions";
    for (const action of node.actions) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = action.label.includes("删除") ? "menu-btn danger" : "menu-btn";
      button.textContent = action.label;
      button.onclick = (event) => {
        event.stopPropagation();
        action.run();
      };
      bar.append(button);
    }
    el.append(hint, bar);
  }`;
if (!js.includes(old)) throw new Error("block missing");
js = js.replace(old, neu);
fs.writeFileSync(jsPath, js);
fs.appendFileSync(cssPath, `
.node { overflow: visible; }
.node-more {
  position: absolute;
  top: 10px;
  right: 12px;
  font-size: 12px;
  color: #667085;
  background: #f4f7fb;
  border-radius: 999px;
  padding: 2px 8px;
}
.node-actions {
  position: absolute;
  left: 12px;
  top: calc(100% + 8px);
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 132px;
  margin: 0;
  padding: 6px;
  background: #fff;
  border: 1px solid #d7e0ea;
  border-radius: 14px;
  box-shadow: 0 14px 32px rgba(28, 36, 48, 0.14);
  opacity: 0;
  pointer-events: none;
  transform: translateY(-4px);
  transition: opacity .16s ease, transform .16s ease;
  z-index: 6;
}
.node:hover .node-actions,
.node:focus-within .node-actions {
  opacity: 1;
  pointer-events: auto;
  transform: translateY(0);
}
.node:hover .node-more { color: #1c2430; background: #e7eef5; }
.menu-btn {
  margin: 0;
  border: 0;
  border-radius: 10px;
  background: transparent;
  color: #1c2430;
  text-align: left;
  padding: 7px 10px;
  cursor: pointer;
}
.menu-btn:hover { background: #f4f7fb; }
.menu-btn.danger { color: #c5342a; }
.menu-btn.danger:hover { background: #fff1f0; }
`);
const copyJs = "C:/Users/jiuzhou/Documents/Codex/2026-10-29/new-chat-3/deploy-system/public/app.js";
const copyCss = "C:/Users/jiuzhou/Documents/Codex/2026-10-29/new-chat-3/deploy-system/public/style.css";
fs.copyFileSync(jsPath, copyJs);
fs.copyFileSync(cssPath, copyCss);
console.log("ok");
