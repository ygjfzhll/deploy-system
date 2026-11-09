const fs = require("fs");
const files = [
  "D:/tmp/deploy-system/public/app.js",
  "C:/Users/jiuzhou/Documents/Codex/2026-10-29/new-chat-3/deploy-system/public/app.js",
];
const oldStart = "function resultState(steps) {";
const next = "function appendResult";
for (const p of files) {
  let c = fs.readFileSync(p, "utf8");
  const start = c.indexOf(oldStart);
  const end = c.indexOf(next);
  if (start < 0 || end < 0) throw new Error("missing in " + p);
  const replacement = `function resultState(steps) {
  if (!runDetail || !steps.length) return { tone: "", title: "未执行", sub: "等待开始" };
  const errored = steps.some((step) => step.status === "failed");
  const unfinished = steps.some((step) => step.status === "skipped" || step.status === "pending" || step.status === "running");
  const allSuccess = steps.every((step) => step.status === "success");
  if (allSuccess) return { tone: "success", title: "成功", sub: "这条线的命令都已完成" };
  if (errored) return { tone: "failed", title: "失败", sub: "有命令报错" };
  if (unfinished) return { tone: "failed", title: "失败", sub: "执行未完成已退出" };
  if (runDetail.status === "running") return { tone: "running", title: "执行中", sub: "尚未结束" };
  return { tone: "", title: "未执行", sub: "等待开始" };
}

`;
  c = c.slice(0, start) + replacement + c.slice(end);
  fs.writeFileSync(p, c);
}
console.log("ok");
