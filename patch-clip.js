const fs = require("fs");
const jsPath = "D:/tmp/deploy-system/public/app.js";
const cssPath = "D:/tmp/deploy-system/public/style.css";
let js = fs.readFileSync(jsPath, "utf8");
js = js.replace(
`  if (node.h) {
    el.style.height = node.h + "px";
    if (node.h < 58) el.classList.add("flat");
  }`,
`  if (!node.h) node.h = 56;
  el.style.height = node.h + "px";
  if (node.h < 58) el.classList.add("flat");`
);
js = js.replace(
`  const kicker = document.createElement("div");`,
`  const body = document.createElement("div");
  body.className = "node-body";
  const kicker = document.createElement("div");`
);
js = js.replace(
`  el.append(kicker, title, sub);`,
`  body.append(kicker, title, sub);
  el.append(body);`
);
js = js.replace(
`  board.style.transform = "scale(" + zoom + ")";`,
`  board.style.transform = "scale(" + zoom + ")";
  board.classList.toggle("board-zoom-mid", zoom < 0.9);
  board.classList.toggle("board-zoom-low", zoom < 0.75);`
);
js = js.replace(
`      if (node.h < 58) el.classList.add("flat");
      el.style.width = node.w + "px";`,
`      el.classList.toggle("flat", node.h < 58);
      el.style.width = node.w + "px";`
);
fs.writeFileSync(jsPath, js);
let css = fs.readFileSync(cssPath, "utf8");
if (!css.includes("node-body")) {
  css += `
.node-body { overflow: hidden; height: 100%; }
#board.board-zoom-mid .sub,
#board.board-zoom-mid .zoom { display: none; }
#board.board-zoom-low .title,
#board.board-zoom-low .sub,
#board.board-zoom-low .zoom { display: none; }
`;
  fs.writeFileSync(cssPath, css);
}
const root = "C:/Users/jiuzhou/Documents/Codex/2026-10-29/new-chat-3/deploy-system/public";
fs.copyFileSync(jsPath, root + "/app.js");
fs.copyFileSync(cssPath, root + "/style.css");
console.log("ok");
