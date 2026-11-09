const fs = require("fs");
const p = "D:/tmp/deploy-system/public/app.js";
let js = fs.readFileSync(p, "utf8");
js = js.replace(
`      el.style.width = node.w + "px";
      el.style.height = node.h + "px";
      sizes[node.id] = { w: node.w, h: node.h };`,
`      el.style.width = node.w + "px";
      el.style.height = node.h + "px";
      el.classList.toggle("flat", node.h < 58);
      sizes[node.id] = { w: node.w, h: node.h };`
);
fs.writeFileSync(p, js);
fs.copyFileSync(p, "C:/Users/jiuzhou/Documents/Codex/2026-10-29/new-chat-3/deploy-system/public/app.js");
console.log("ok");
