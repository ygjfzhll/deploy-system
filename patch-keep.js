const fs = require("fs");
const files = [
  "D:/tmp/deploy-system/public/app.js",
  "C:/Users/jiuzhou/Documents/Codex/2026-10-29/new-chat-3/deploy-system/public/app.js",
];
for (const p of files) {
  let c = fs.readFileSync(p, "utf8");
  if (!c.includes("let lineView")) {
    c = c.replace(
      "let lineStatus = {};",
      "let lineStatus = {};\nlet lineView = {};"
    );
  }
  const start = c.indexOf("function lineStepsFor");
  const end = c.indexOf("function redrawWires");
  if (start < 0 || end < 0) throw new Error("block missing " + p);
  const block = `function readViews() {
  try { return JSON.parse(localStorage.getItem("deploy-line-view") || "{}"); }
  catch (error) { return {}; }
}

function saveView() {
  const all = readViews();
  all[planId || "none"] = lineView;
  localStorage.setItem("deploy-line-view", JSON.stringify(all));
}

function restoreView() {
  const all = readViews();
  lineView = all[planId || "none"] || {};
  lineStatus = {};
  for (const [id, item] of Object.entries(lineView)) {
    lineStatus[id] = item.cleared ? [] : (item.steps || []);
  }
}

function lineStepsFor(host) {
  if (Object.prototype.hasOwnProperty.call(lineStatus, String(host.id)) || Object.prototype.hasOwnProperty.call(lineStatus, host.id)) {
    return lineStatus[host.id] || lineStatus[String(host.id)] || [];
  }
  return [];
}

function resultState(steps, inThisRun) {
  if (!inThisRun || !steps.length) return { tone: "", title: "未执行", sub: "这条线还没开始" };
  const errored = steps.some((step) => step.status === "failed" || step.status === "skipped");
  const allSuccess = steps.every((step) => step.status === "success");
  if (allSuccess) return { tone: "success", title: "成功", sub: "这条线的命令都已完成" };
  if (errored) return { tone: "failed", title: "失败", sub: steps.some((step) => step.status === "failed") ? "有命令报错" : "执行未完成已退出" };
  return { tone: "", title: "未执行", sub: "还没走到这里" };
}

function appendResult(nodes, edges, previous, id, steps, inThisRun, hostId) {
  const stateText = resultState(steps, inThisRun);
  const saved = lineView[hostId] || lineView[String(hostId)] || {};
  const sub = saved.finishedAt ? stateText.sub + " · 完成时间 " + saved.finishedAt : stateText.sub;
  const node = place({
    id,
    x: previous.x + 290,
    y: previous.y,
    kicker: "执行结果",
    title: stateText.title,
    sub,
    tone: stateText.tone,
    badge: stateText.title === "未执行" ? "" : stateText.title,
  });
  nodes.push(node);
  edges.push([previous, node, stateText.tone === "failed" ? "failed" : stateText.tone === "success" ? "success" : ""]);
}

`;
  c = c.slice(0, start) + block + c.slice(end);
  c = c.replace(
    'appendResult(nodes, edges, previous, "result-" + host.id, sourceSteps, hostSteps.length > 0);',
    'appendResult(nodes, edges, previous, "result-" + host.id, sourceSteps, hostSteps.length > 0, host.id);'
  );
  c = c.replace(
`async function loadState() {
  state = await api("/api/state");
  renderSelect();
  draw();
}`,
`async function loadState() {
  state = await api("/api/state");
  renderSelect();
  restoreView();
  draw();
}`
  );
  c = c.replace(
`document.querySelector("#plan-select").onchange = (event) => {
  planId = event.target.value;
  runDetail = null;
  draw();
};`,
`document.querySelector("#plan-select").onchange = (event) => {
  planId = event.target.value;
  runDetail = null;
  restoreView();
  draw();
};`
  );
  c = c.replace(
`async function refreshLine(host) {
  try {
    const plan = currentPlan();
    if (!plan) throw new Error("请先选择方案");
    const data = await api("/api/lines/" + host.id + "?planId=" + plan.id);
    lineStatus[host.id] = data.steps || [];
    draw();
  } catch (error) {
    alert(error.message);
  }
}`,
`function refreshLine(host) {
  const previous = lineView[host.id] || lineView[String(host.id)] || {};
  lineStatus[host.id] = [];
  lineView[host.id] = { steps: [], cleared: true, finishedAt: previous.finishedAt || "" };
  saveView();
  draw();
}`
  );
  c = c.replace(
`  for (const key of Object.keys(grouped)) lineStatus[key] = grouped[key];
  draw();`,
`  for (const key of Object.keys(grouped)) {
    const steps = grouped[key];
    lineStatus[key] = steps;
    const finished = steps.length > 0 && steps.every((step) => step.status === "success" || step.status === "failed" || step.status === "skipped");
    const previous = lineView[key] || {};
    const finishedAt = finished ? ((steps.slice().reverse().find((step) => step.finished_at) || {}).finished_at || previous.finishedAt || "") : (previous.finishedAt || "");
    lineView[key] = { steps, cleared: false, finishedAt };
  }
  saveView();
  draw();`
  );
  fs.writeFileSync(p, c);
}
console.log("ok");
