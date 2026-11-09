const fs = require("fs");
const files = [
  "D:/tmp/deploy-system/public/app.js",
  "C:/Users/jiuzhou/Documents/Codex/2026-10-29/new-chat-3/deploy-system/public/app.js",
];
for (const p of files) {
  let c = fs.readFileSync(p, "utf8");
  const start = c.indexOf("function resultState(steps) {");
  const end = c.indexOf("function appendResult");
  if (start < 0 || end < 0) throw new Error("missing " + p);
  const fn = `function resultState(steps, inThisRun) {
  if (!inThisRun || !runDetail) return { tone: "", title: "未执行", sub: "这条线还没开始" };
  const errored = steps.some((step) => step.status === "failed");
  const allSuccess = steps.length > 0 && steps.every((step) => step.status === "success");
  if (allSuccess) return { tone: "success", title: "成功", sub: "这条线的命令都已完成" };
  if (errored) return { tone: "failed", title: "失败", sub: "有命令报错" };
  const stopped = runDetail.status === "failed" || runDetail.status === "cancelled";
  const unfinished = steps.some((step) => step.status === "skipped" || step.status === "pending" || step.status === "running");
  if (stopped && unfinished) return { tone: "failed", title: "失败", sub: "执行未完成已退出" };
  return { tone: "", title: "未执行", sub: "还没走到这里" };
}

`;
  c = c.slice(0, start) + fn + c.slice(end);
  c = c.replace(
    "const stateText = resultState(steps);",
    "const stateText = resultState(steps, inThisRun);"
  );
  c = c.replace(
    "function appendResult(nodes, edges, previous, id, steps) {",
    "function appendResult(nodes, edges, previous, id, steps, inThisRun) {"
  );
  c = c.replace(
`    if (failed) hostNode.tone = "failed";
    else if (running) hostNode.tone = "running";
    else if (done) hostNode.tone = "success";
    if (hostSteps.length) hostNode.badge = failed ? "失败" : running ? "执行中" : done ? "完成" : "等待";`,
`    const lineDone = hostSteps.length && hostSteps.every((step) => step.status === "success");
    if (failed) hostNode.tone = "failed";
    else if (running) hostNode.tone = "running";
    else if (lineDone) hostNode.tone = "success";
    if (failed || running || lineDone) hostNode.badge = failed ? "失败" : running ? "执行中" : "完成";`
  );
  c = c.replace(
`        tone: step.status || "",
        badge: step.status ? statusLabel[step.status] : "",`,
`        tone: step.status && step.status !== "pending" ? step.status : "",
        badge: step.status && step.status !== "pending" ? statusLabel[step.status] : "",`
  );
  c = c.replace(
    'appendResult(nodes, edges, previous, "result-" + host.id, sourceSteps);',
    'appendResult(nodes, edges, previous, "result-" + host.id, sourceSteps, hostSteps.length > 0);'
  );
  fs.writeFileSync(p, c);
}
console.log("ok");
