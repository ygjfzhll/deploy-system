const fs = require("fs");
const jsPath = "D:/tmp/deploy-system/public/app.js";
const cssPath = "D:/tmp/deploy-system/public/style.css";
let js = fs.readFileSync(jsPath, "utf8");
js = js.replace("node.h = Math.max(72, startH + (ev.clientY - sy) / zoom);", "node.h = Math.max(34, startH + (ev.clientY - sy) / zoom);");
js = js.replace(
  'if (node.h) el.style.height = node.h + "px";',
  'if (node.h) {\n    el.style.height = node.h + "px";\n    if (node.h < 58) el.classList.add("flat");\n  }'
);
js = js.replace("let hostY = 230;", "let hostY = 28;");
js = js.replace(
  "hostY += Math.max(150, sourceSteps.some((step) => step.output) ? 250 : 150);",
  `const rowIds = ["host-" + host.id, "result-" + host.id].concat(sourceSteps.map((_, index) => "step-" + host.id + "-" + index));
    const rowHeight = Math.max(34, ...rowIds.map((id) => (sizes[id] && sizes[id].h) || 58));
    hostY += rowHeight + 14;`
);
fs.writeFileSync(jsPath, js);
let css = fs.readFileSync(cssPath, "utf8");
css = css.replace("min-height: 86px;", "min-height: 0;");
if (!css.includes(".node.flat")) {
  css += `
.node.flat { padding: 4px 10px; }
.node.flat .sub,
.node.flat .zoom,
.node.flat .log { display: none; }
.node.flat .title { margin-top: 0; }
`;
  fs.writeFileSync(cssPath, css);
}
const root = "C:/Users/jiuzhou/Documents/Codex/2026-10-29/new-chat-3/deploy-system/public";
fs.copyFileSync(jsPath, root + "/app.js");
fs.copyFileSync(cssPath, root + "/style.css");
console.log("ok");
