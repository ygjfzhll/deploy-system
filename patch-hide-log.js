const fs = require("fs");
const jsPath = "D:/tmp/deploy-system/public/app.js";
let js = fs.readFileSync(jsPath, "utf8");
const old = `  if (node.log) {
    const pre = document.createElement("pre");
    pre.className = "log";
    pre.textContent = node.log;
    el.append(pre);
    const zoom = document.createElement("button");`;
const neu = `  if (node.log) {
    const zoom = document.createElement("button");`;
if (!js.includes(old)) throw new Error("log block missing");
js = js.replace(old, neu);
fs.writeFileSync(jsPath, js);
fs.copyFileSync(jsPath, "C:/Users/jiuzhou/Documents/Codex/2026-10-29/new-chat-3/deploy-system/public/app.js");
console.log("ok");
