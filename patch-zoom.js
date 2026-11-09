const fs = require("fs");
const htmlPath = "D:/tmp/deploy-system/public/index.html";
const cssPath = "D:/tmp/deploy-system/public/style.css";
const jsPath = "D:/tmp/deploy-system/public/app.js";
let html = fs.readFileSync(htmlPath, "utf8");
if (!html.includes("zoom-out")) {
  html = html.replace(
    '<span class="spacer"></span>',
    `<span class="spacer"></span>
    <div class="zoom-bar">
      <button id="zoom-out" class="ghost" type="button">缩小</button>
      <span id="zoom-label">100%</span>
      <button id="zoom-in" class="ghost" type="button">放大</button>
    </div>`
  );
  html = html.replace(
    '<div id="viewport">\n    <div id="board"></div>\n  </div>',
    '<div id="viewport">\n    <div id="board-scale"><div id="board"></div></div>\n  </div>'
  );
  fs.writeFileSync(htmlPath, html);
}
let css = fs.readFileSync(cssPath, "utf8");
if (!css.includes("zoom-bar")) {
  css += `
.zoom-bar { display: flex; align-items: center; gap: 6px; }
#zoom-label { min-width: 52px; text-align: center; color: #667085; font-size: 13px; }
#board-scale { position: relative; }
#board { transform-origin: 0 0; }
#panel { resize: both; overflow: auto; min-width: 280px; min-height: 240px; }
#viewer { resize: both; }
.resize-handle {
  position: absolute;
  right: 4px;
  bottom: 4px;
  width: 12px;
  height: 12px;
  border-right: 2px solid #b7c3d0;
  border-bottom: 2px solid #b7c3d0;
  cursor: nwse-resize;
}
`;
  fs.writeFileSync(cssPath, css);
}
let js = fs.readFileSync(jsPath, "utf8");
if (!js.includes("let zoom")) {
  js = js.replace(
    "let positions = JSON.parse(localStorage.getItem(\"deploy-node-pos\") || \"{}\");",
    "let positions = JSON.parse(localStorage.getItem(\"deploy-node-pos\") || \"{}\");\nlet sizes = JSON.parse(localStorage.getItem(\"deploy-node-size\") || \"{}\");\nlet zoom = Number(localStorage.getItem(\"deploy-zoom\") || \"1\");"
  );
}
js = js.replace(
`  const x1 = from.x + 230;
  const y1 = from.y + 48;
  const x2 = to.x;
  const y2 = to.y + 48;`,
`  const x1 = from.x + (from.w || 230);
  const y1 = from.y + (from.h || 86) / 2;
  const x2 = to.x;
  const y2 = to.y + (to.h || 86) / 2;`
);
if (!js.includes("resize-handle")) {
  js = js.replace(
    "  el.style.left = node.x + \"px\";\n  el.style.top = node.y + \"px\";",
    `  const savedSize = sizes[node.id];
  if (savedSize) {
    node.w = savedSize.w;
    node.h = savedSize.h;
  }
  el.style.left = node.x + "px";
  el.style.top = node.y + "px";
  el.style.width = (node.w || 230) + "px";
  if (node.h) el.style.height = node.h + "px";
  const handle = document.createElement("div");
  handle.className = "resize-handle";
  handle.title = "调整大小";
  handle.addEventListener("pointerdown", (event) => {
    event.stopPropagation();
    const startW = el.offsetWidth;
    const startH = el.offsetHeight;
    const sx = event.clientX;
    const sy = event.clientY;
    const move = (ev) => {
      node.w = Math.max(180, startW + (ev.clientX - sx) / zoom);
      node.h = Math.max(72, startH + (ev.clientY - sy) / zoom);
      el.style.width = node.w + "px";
      el.style.height = node.h + "px";
      sizes[node.id] = { w: node.w, h: node.h };
      redrawWires();
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      localStorage.setItem("deploy-node-size", JSON.stringify(sizes));
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  });
  el.append(handle);`
  );
}
js = js.replace(
`      if (Math.abs(dx) + Math.abs(dy) > 4) moved = true;
      node.x = origX + dx;
      node.y = origY + dy;`,
`      if (Math.abs(dx) + Math.abs(dy) > 4) moved = true;
      node.x = origX + dx / zoom;
      node.y = origY + dy / zoom;`
);
if (!js.includes("function applyZoom")) {
  js = js.replace(
    "function redrawWires() {",
    `function applyZoom() {
  zoom = Math.min(1.8, Math.max(0.5, Math.round(zoom * 100) / 100));
  const board = document.querySelector("#board");
  const scale = document.querySelector("#board-scale");
  if (!board) return;
  board.style.transform = "scale(" + zoom + ")";
  const label = document.querySelector("#zoom-label");
  if (label) label.textContent = Math.round(zoom * 100) + "%";
  if (scale) {
    scale.style.width = board.offsetWidth * zoom + "px";
    scale.style.height = board.offsetHeight * zoom + "px";
  }
  localStorage.setItem("deploy-zoom", String(zoom));
}

function redrawWires() {`
  );
  js = js.replace(
    "board.style.height = height + \"px\";\n  svg.setAttribute(\"width\", width);",
    "board.style.height = height + \"px\";\n  applyZoom();\n  svg.setAttribute(\"width\", width);"
  );
  js = js.replace(
    "board.style.height = graph.height + \"px\";",
    "board.style.height = graph.height + \"px\";\n  applyZoom();"
  );
  js = js.replace(
    "loadState().catch((error) => alert(error.message));",
    `document.querySelector("#zoom-in").onclick = () => { zoom += 0.1; applyZoom(); };
document.querySelector("#zoom-out").onclick = () => { zoom -= 0.1; applyZoom(); };
document.querySelector("#viewport").addEventListener("wheel", (event) => {
  if (!event.ctrlKey) return;
  event.preventDefault();
  zoom += event.deltaY < 0 ? 0.1 : -0.1;
  applyZoom();
}, { passive: false });
applyZoom();
loadState().catch((error) => alert(error.message));`
  );
}
fs.writeFileSync(jsPath, js);
const root = "C:/Users/jiuzhou/Documents/Codex/2026-10-29/new-chat-3/deploy-system/public";
fs.copyFileSync(htmlPath, root + "/index.html");
fs.copyFileSync(cssPath, root + "/style.css");
fs.copyFileSync(jsPath, root + "/app.js");
console.log("ok");
