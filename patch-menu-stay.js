const fs = require("fs");
const cssPath = "D:/tmp/deploy-system/public/style.css";
const jsPath = "D:/tmp/deploy-system/public/app.js";
let css = fs.readFileSync(cssPath, "utf8");
css = css.replace(
`.node-actions {
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
.node:hover .node-more { color: #1c2430; background: #e7eef5; }`,
`.node-actions {
  position: absolute;
  left: 12px;
  top: calc(100% + 8px);
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 148px;
  margin: 0;
  padding: 6px;
  background: #fff;
  border: 1px solid #d7e0ea;
  border-radius: 14px;
  box-shadow: 0 14px 32px rgba(28, 36, 48, 0.14);
  opacity: 0;
  pointer-events: none;
  transform: translateY(-4px);
  transition: opacity .16s ease .45s, transform .16s ease .45s;
  z-index: 6;
}
.node-actions::before {
  content: "";
  position: absolute;
  left: 0;
  right: 0;
  top: -16px;
  height: 16px;
}
.node:hover .node-actions,
.node:focus-within .node-actions,
.node.menu-open .node-actions {
  opacity: 1;
  pointer-events: auto;
  transform: translateY(0);
  transition-delay: 0s;
}
.node:hover .node-more,
.node.menu-open .node-more { color: #1c2430; background: #e7eef5; }`
);
fs.writeFileSync(cssPath, css);
let js = fs.readFileSync(jsPath, "utf8");
js = js.replace(
  'if (event.target.closest("button")) return;',
  'if (event.target.closest("button, .node-more, .node-actions")) return;'
);
if (!js.includes("menu-open")) {
  js = js.replace(
    `    hint.className = "node-more";
    hint.textContent = "操作";`,
    `    hint.className = "node-more";
    hint.textContent = "操作";
    hint.onclick = (event) => {
      event.stopPropagation();
      const opening = !el.classList.contains("menu-open");
      document.querySelectorAll(".node.menu-open").forEach((node) => node.classList.remove("menu-open"));
      if (opening) el.classList.add("menu-open");
    };`
  );
  js = js.replace(
    "loadState().catch((error) => alert(error.message));",
    `document.addEventListener("pointerdown", (event) => {
  if (!event.target.closest(".node")) {
    document.querySelectorAll(".node.menu-open").forEach((node) => node.classList.remove("menu-open"));
  }
});

loadState().catch((error) => alert(error.message));`
  );
}
fs.writeFileSync(jsPath, js);
const root = "C:/Users/jiuzhou/Documents/Codex/2026-10-29/new-chat-3/deploy-system/public";
fs.copyFileSync(cssPath, root + "/style.css");
fs.copyFileSync(jsPath, root + "/app.js");
console.log("ok", js.includes("menu-open"), css.includes("transition-delay"));
