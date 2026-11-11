let state = { hosts: [], plans: [], runs: [] };
let planId = localStorage.getItem("deploy-plan-id");
let runDetail = null;
let lineStatus = {};
let lineView = {};
let graph = null;
let positions = JSON.parse(localStorage.getItem("deploy-node-pos") || "{}");
let sizes = JSON.parse(localStorage.getItem("deploy-node-size") || "{}");
let zoom = Number(localStorage.getItem("deploy-zoom") || "1");
let timer = null;

const kindLabel = { remote: "远程命令", upload: "上传", download: "下载", local: "本机命令" };

function liveCommand(step, planStep) {
  if (planStep && (planStep.command || planStep.local_path)) return planStep.command || planStep.local_path;
  return step.command || step.preview || step.local_path || "未填写";
}

function stepCaption(step, planStep) {
  const note = (planStep && planStep.note) || step.note || "";
  return note.trim() || kindLabel[step.kind] || "命令";
}
const statusLabel = { pending: "等待", running: "执行中", success: "成功", failed: "失败", skipped: "跳过", cancelled: "已停止" };

async function api(url, options) {
  const response = await fetch(url, options);
  const data = await response.json().catch(() => ({}));
  if (response.status === 401 && !url.startsWith("/api/login")) {
    showLogin();
    throw new Error(data.error || "未登录");
  }
  if (!response.ok) throw new Error(data.error || "请求失败");
  return data;
}

function showLogin() {
  document.querySelector("#login-screen").hidden = false;
  document.querySelector("#app-shell").hidden = true;
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
}

let currentUser = null;
function showApp(user) {
  currentUser = user;
  document.querySelector("#login-screen").hidden = true;
  document.querySelector("#app-shell").hidden = false;
  document.querySelector("#who").textContent = user.username;
  document.querySelector("#login-error").textContent = "";
  document.querySelector("#manage-users").hidden = !user.isAdmin;
}

function currentPlan() {
  return state.plans.find((plan) => String(plan.id) === String(planId));
}

function planHosts() {
  const plan = currentPlan();
  const ids = new Set((plan && plan.hostIds || []).map((id) => String(id)));
  return state.hosts.filter((host) => ids.has(String(host.id)));
}

function openPanel(title, fields, onSubmit, onDelete) {
  const panel = document.querySelector("#panel");
  panel.hidden = false;
  document.querySelector("#panel-title").textContent = title;
  const form = document.querySelector("#panel-form");
  form.innerHTML = "";
  for (const field of fields) {
    const label = document.createElement("label");
    label.textContent = field.label;
    const input = document.createElement(field.type === "textarea" ? "textarea" : "input");
    input.name = field.name;
    input.value = field.value || "";
    if (field.name === "password" || field.type === "password") input.type = "password";
    if (field.placeholder) input.placeholder = field.placeholder;
    if (field.type === "number") input.type = "number";
    form.append(label, input);
  }
  const actions = document.createElement("div");
  actions.className = "actions";
  const save = document.createElement("button");
  save.type = "submit";
  save.textContent = "保存";
  actions.append(save);
  if (onDelete) {
    const del = document.createElement("button");
    del.type = "button";
    del.className = "ghost";
    del.textContent = "删除";
    del.onclick = onDelete;
    actions.append(del);
  }
  form.append(actions);
  form.onsubmit = async (event) => {
    event.preventDefault();
    const values = Object.fromEntries(new FormData(form).entries());
    try {
      await onSubmit(values);
      panel.hidden = true;
    } catch (error) {
      alert(error.message);
    }
  };
}

document.querySelector("#panel-close").onclick = () => {
  document.querySelector("#panel").hidden = true;
};

async function savePlan(plan, steps) {
  const body = { id: plan.id, name: plan.name };
  if (steps) body.steps = steps;
  const saved = await api("/api/plans", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  planId = saved.id;
  await loadState();
}

function stepsPayload(plan, extra) {
  const steps = plan.steps.map((step) => ({
    kind: step.kind,
    command: step.command,
    localPath: step.local_path,
    remotePath: step.remote_path,
  }));
  if (extra) steps.push(extra);
  return steps;
}

async function createPlan() {
  const name = prompt("项目名称", "发布流程");
  if (!name) throw new Error("请先建立项目");
  const saved = await api("/api/plans", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  });
  planId = saved.id;
  await loadState();
  return currentPlan();
}

async function ensurePlan() {
  if (currentPlan()) return currentPlan();
  return createPlan();
}

function nodeElement(node) {
  const el = document.createElement("article");
  el.className = "node " + (node.tone || "");
  const savedSize = sizes[node.id];
  if (savedSize) {
    node.w = savedSize.w;
    node.h = savedSize.h;
  }
  el.style.left = node.x + "px";
  el.style.top = node.y + "px";
  el.style.width = (node.w || 230) + "px";
  if (!node.h) node.h = 56;
  el.style.height = node.h + "px";
  if (node.h < 58) el.classList.add("flat");
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
      node.h = Math.max(34, startH + (ev.clientY - sy) / zoom);
      el.style.width = node.w + "px";
      el.style.height = node.h + "px";
      el.classList.toggle("flat", node.h < 58);
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
  el.append(handle);
  const body = document.createElement("div");
  body.className = "node-body";
  const kicker = document.createElement("div");
  kicker.className = "kicker";
  kicker.textContent = node.kicker;
  if (node.badge) {
    const badge = document.createElement("span");
    badge.className = "badge " + (node.tone || "");
    badge.textContent = node.badge;
    kicker.append(badge);
  }
  const title = document.createElement("div");
  title.className = "title";
  title.textContent = node.title;
  const sub = document.createElement("div");
  sub.className = "sub";
  sub.textContent = node.sub || "";
  body.append(kicker, title, sub);
  if (node.finishedAt) {
    const pop = document.createElement("div");
    pop.className = "node-pop";
    pop.textContent = (node.title === "失败" ? "最近失败时间 " : "最近成功时间 ") + node.finishedAt;
    el.append(pop);
  }
  el.append(body);
  if (node.actions) {
    const hint = document.createElement("div");
    hint.className = "node-more";
    hint.textContent = "操作";
    hint.onclick = (event) => {
      event.stopPropagation();
      const opening = !el.classList.contains("menu-open");
      document.querySelectorAll(".node.menu-open").forEach((node) => node.classList.remove("menu-open"));
      if (opening) el.classList.add("menu-open");
    };
    const bar = document.createElement("div");
    bar.className = "node-actions";
    for (const action of node.actions) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = action.label.includes("删除") ? "menu-btn danger" : "menu-btn";
      button.textContent = action.label;
      if (action.disabled) {
        button.disabled = true;
      } else {
        button.onclick = (event) => {
          event.stopPropagation();
          action.run();
        };
      }
      bar.append(button);
    }
    el.append(hint, bar);
  }
  if (node.log) {
    const pop = document.createElement("div");
    pop.className = "node-pop";
    pop.textContent = node.log.replace(/本次未重复执行/g, "").trim();
    el.append(pop);
    const zoom = document.createElement("button");
    zoom.type = "button";
    zoom.className = "zoom";
    zoom.textContent = "放大查看";
    zoom.onclick = (event) => {
      event.stopPropagation();
      openViewer(node);
    };
    el.append(zoom);
  }
  el.addEventListener("pointerdown", (event) => {
    if (event.target.closest("button, .node-more, .node-actions")) return;
    const startX = event.clientX;
    const startY = event.clientY;
    const origX = node.x;
    const origY = node.y;
    let moved = false;
    document.body.classList.add("dragging-node");
    const alongLine = !!(node.stepId && (node.kind === "upload" || node.kind === "download" || node.kind === "remote" || node.kind === "local"));
    const move = (ev) => {
      const dx = ev.clientX - startX;
      const dy = ev.clientY - startY;
      if (Math.abs(dx) + Math.abs(dy) > 4) moved = true;
      node.x = origX + dx / zoom;
      node.y = origY + dy / zoom;
      el.style.left = node.x + "px";
      el.style.top = node.y + "px";
      if (alongLine && node.stepId) positions["step-keep-" + node.stepId] = { x: node.x, y: node.y };
      else positions[node.id] = { x: node.x, y: node.y };
      redrawWires();
    };
    const up = async () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      document.body.classList.remove("dragging-node");
      if (!moved) return;
      el.dataset.dragged = "1";
      localStorage.setItem("deploy-node-pos", JSON.stringify(positions));
      if (alongLine && node.stepId) {
        try { await reorderLine(node); }
        catch (error) { alert(error.message); await loadState(); }
      }
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  });
  el.onclick = (event) => {
    event.stopPropagation();
    if (el.dataset.dragged === "1") {
      el.dataset.dragged = "";
      return;
    }
    if (node.onClick) node.onClick();
  };
  return el;
}

async function reorderLine(node) {
  const plan = currentPlan();
  const steps = plan.steps.filter((step) => String(step.host_id) === String(node.hostId));
  const others = steps.filter((step) => String(step.id) !== String(node.stepId));
  const hostNode = graph.nodes.find((item) => item.id === "host-" + node.hostId);
  const anchors = [{ x: hostNode ? hostNode.x + 115 : 0, y: hostNode ? hostNode.y + 28 : node.y, at: 0 }];
  others.forEach((step, index) => {
    const visual = graph.nodes.find((item) => String(item.stepId) === String(step.id));
    anchors.push({
      x: visual ? visual.x + 115 : 700 + index * 290,
      y: visual ? visual.y + 28 : node.y,
      at: index + 1,
    });
  });
  const dropX = node.x + 115;
  const dropY = node.y + 28;
  let at = 0;
  let best = Infinity;
  anchors.forEach((anchor) => {
    const dist = Math.hypot(anchor.x - dropX, anchor.y - dropY);
    if (dist < best) {
      best = dist;
      at = anchor.at;
    }
  });
  const after = others.map((step) => step.id);
  after.splice(at, 0, node.stepId);
  const before = steps.map((step) => step.id);
  if (before.join(",") === after.join(",")) return;
  const newIndex = after.findIndex((id) => String(id) === String(node.stepId));
  const lineY = hostNode ? hostNode.y : node.y;
  const lineX = hostNode ? hostNode.x : 360;
  positions["step-keep-" + node.stepId] = { x: lineX + 340 + Math.max(0, newIndex) * 290, y: lineY };
  localStorage.setItem("deploy-node-pos", JSON.stringify(positions));
  await api("/api/steps/reorder", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ planId: Number(plan.id), hostId: Number(node.hostId), stepIds: after }),
  });
  await loadState();
}

function place(node) {
  const saved = (node.stepId && positions["step-keep-" + node.stepId]) || positions[node.id];
  if (saved) {
    node.x = saved.x;
    node.y = saved.y;
  }
  return node;
}

function readViews() {
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

function disabledSkip(step) {
  return step.status === "skipped" && String(step.output || "").includes("已禁用");
}

function resultState(steps, inThisRun) {
  if (!inThisRun || !steps.length) return { tone: "", title: "未执行", sub: "这条线还没开始" };
  const active = steps.filter((step) => !disabledSkip(step));
  if (!active.length) return { tone: "success", title: "成功", sub: "禁用的步骤已跳过" };
  const errored = active.some((step) => step.status === "failed" || step.status === "skipped");
  const allSuccess = active.every((step) => step.status === "success");
  if (allSuccess) return { tone: "success", title: "成功", sub: "这条线的命令都已完成" };
  if (errored) return { tone: "failed", title: "失败", sub: steps.some((step) => step.status === "failed") ? "有命令报错" : "执行未完成已退出" };
  return { tone: "", title: "未执行", sub: "还没走到这里" };
}

function appendResult(nodes, edges, previous, id, steps, inThisRun, hostId, disabled) {
  const stateText = resultState(steps, inThisRun);
  const saved = lineView[hostId] || lineView[String(hostId)] || {};
  const fromSteps = ([...steps].reverse().find((step) => step.finished_at) || {}).finished_at || "";
  const showTime = stateText.title === "成功" || stateText.title === "失败";
  saved.finishedAt = showTime ? (saved.finishedAt || fromSteps) : "";
  const sub = stateText.sub;
  const node = place({
    id,
    x: previous.x + 290,
    y: previous.y,
    kicker: "执行结果",
    title: stateText.title,
    sub,
    finishedAt: saved.finishedAt || "",
    tone: disabled ? "disabled" : stateText.tone,
    badge: disabled ? "已禁用" : (stateText.title === "未执行" ? "" : stateText.title),
    title: disabled ? "已禁用" : stateText.title,
    sub: disabled ? "这条线不会执行" : sub,
  });
  nodes.push(node);
  edges.push([previous, node, stateText.tone === "failed" ? "failed" : stateText.tone === "success" ? "success" : ""]);
}

function applyZoom() {
  zoom = Math.min(1.8, Math.max(0.5, Math.round(zoom * 100) / 100));
  const board = document.querySelector("#board");
  const scale = document.querySelector("#board-scale");
  if (!board) return;
  board.style.transform = "scale(" + zoom + ")";
  board.classList.toggle("board-zoom-mid", zoom < 0.9);
  board.classList.toggle("board-zoom-low", zoom < 0.75);
  const label = document.querySelector("#zoom-label");
  if (label) label.textContent = Math.round(zoom * 100) + "%";
  if (scale) {
    scale.style.width = board.offsetWidth * zoom + "px";
    scale.style.height = board.offsetHeight * zoom + "px";
  }
  localStorage.setItem("deploy-zoom", String(zoom));
}

let wireFrame = 0;
function redrawWires() {
  if (wireFrame) return;
  wireFrame = requestAnimationFrame(() => {
    wireFrame = 0;
    const board = document.querySelector("#board");
    const svg = board && board.querySelector("svg.wires");
    if (!svg || !graph) return;
    const width = Math.max(1100, ...graph.nodes.map((node) => node.x + 320));
    const height = Math.max(640, ...graph.nodes.map((node) => node.y + 240));
    board.style.width = width + "px";
    board.style.height = height + "px";
    svg.setAttribute("width", width);
    svg.setAttribute("height", height);
    svg.replaceChildren();
    for (const [from, to, tone] of graph.edges) curve(svg, from, to, tone);
  });
}

function curve(svg, from, to, tone) {
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  const x1 = from.x + (from.w || 230);
  const y1 = from.y + (from.h || 86) / 2;
  const x2 = to.x;
  const y2 = to.y + (to.h || 86) / 2;
  const mid = (x1 + x2) / 2;
  path.setAttribute("d", "M " + x1 + " " + y1 + " C " + mid + " " + y1 + ", " + mid + " " + y2 + ", " + x2 + " " + y2);
  path.setAttribute("fill", "none");
  path.setAttribute("stroke", tone === "failed" ? "#c5342a" : tone === "success" ? "#1f7a4d" : "#8aa0b8");
  path.setAttribute("stroke-width", tone === "failed" ? "2.5" : "1.8");
  svg.append(path);
}

function buildGraph() {
  const plan = currentPlan();
  if (!plan) return { nodes: [], edges: [], width: 1100, height: 640 };
  const nodes = [];
  const edges = [];
  const root = {
    id: "root",
    x: 48,
    y: 72,
    kicker: "项目",
    title: plan ? plan.name : "还没有项目",
    sub: plan ? plan.steps.length + " 个命令 · " + planHosts().length + " 台机器" : "点击新建项目",
    tone: "root",
    onClick: () => editPlanName(),
    actions: [
      { label: "刷新所有线", disabled: runInProgress(), run: () => refreshAllLines().catch((error) => alert(error.message)) },
      { label: "一键禁用", run: () => setAllLines(true) },
      { label: "一键启用", run: () => setAllLines(false) },
      { label: "AI 起草", run: () => openAiDraft() },
    ],
  };
  nodes.push(place(root));
  let hostY = 28;
  for (const host of planHosts()) {
    const disabled = !!(plan && (plan.disabledHostIds || []).some((id) => Number(id) === Number(host.id)));
    const hostNode = {
      id: "host-" + host.id,
      hostId: host.id,
      x: 360,
      y: hostY,
      kicker: "目标机器",
      title: host.name,
      sub: host.username + "@" + host.ip + ":" + host.port,
      onClick: () => editHost(host),
      actions: [
        { label: "刷新这条线", run: () => refreshLine(host) },
        { label: "执行这条线", run: () => runLine(host.id) },
        { label: "添加命令", run: () => addStep("remote", host.id) },
        { label: "添加上传", run: () => addStep("upload", host.id) },
        { label: "添加下载", run: () => addStep("download", host.id) },
        { label: "复制这条线", run: () => copyLine(host) },
        { label: disabled ? "启用这条线" : "禁用这条线", run: () => toggleLine(host, !disabled) },
        { label: "删除这条线", run: () => deleteLine(host) },
      ],
    };
    if (disabled) hostNode.tone = "disabled";
    const hostSteps = lineStepsFor(host);
    const failed = hostSteps.some((step) => step.status === "failed");
    const running = hostSteps.some((step) => step.status === "running");
    const done = hostSteps.length && hostSteps.every((step) => step.status === "success" || step.status === "skipped");
    const activeSteps = hostSteps.filter((step) => !disabledSkip(step));
    const lineDone = hostSteps.length && activeSteps.every((step) => step.status === "success");
    if (!disabled && failed) hostNode.tone = "failed";
    else if (!disabled && running) hostNode.tone = "running";
    else if (!disabled && lineDone) hostNode.tone = "success";
    if (disabled) hostNode.badge = "已禁用";
    else if (failed || running || lineDone) hostNode.badge = failed ? "失败" : running ? "执行中" : "完成";
    nodes.push(place(hostNode));
    edges.push([root, hostNode, hostNode.tone]);
    let previous = hostNode;
    const ownSteps = (plan ? plan.steps.filter((step) => String(step.host_id) === String(host.id)) : []).slice().sort((a, b) => a.position - b.position || a.id - b.id);
    const runById = {};
    hostSteps.forEach((step) => { if (step.step_id) runById[step.step_id] = step; });
    const sourceSteps = ownSteps.map((planStep, index) => runById[planStep.id] || { ...planStep, position: index + 1, preview: planStep.command || planStep.local_path, status: "" });
    sourceSteps.forEach((step, index) => {
      const planStep = ownSteps[index];
      const commandText = liveCommand(step, planStep);
      const stepOff = !!(planStep && Number(planStep.disabled));
      const child = {
        id: "step-" + host.id + "-" + index,
        x: 700 + index * 290,
        y: hostY,
        hostId: host.id,
        stepId: planStep && planStep.id,
        kind: (planStep && planStep.kind) || step.kind,
        kicker: (index + 1) + " · " + stepCaption(step, planStep),
        title: commandText,
        sub: step.remote_path || step.host_label || "",
        tone: disabled || stepOff ? "disabled" : (step.status && step.status !== "pending" ? step.status : ""),
        badge: stepOff ? "已禁用" : (disabled ? "" : (step.status && step.status !== "pending" ? statusLabel[step.status] : "")),
        log: step.output || "",
        onClick: () => editStep(planStep || step),
        actions: [
          ...(step.status === "failed" ? [{ label: "从这里继续", run: () => runLine(host.id, (planStep && planStep.id) || step.step_id) }] : []),
          { label: "查看命令", run: () => openViewer({ title: "完整命令", kicker: "查看", sub: "", badge: "", log: commandText }) },
          { label: "查看执行结果", run: () => openViewer({ title: "执行结果", kicker: "结果", sub: "", badge: "", log: (step.output || "").replace(/本次未重复执行/g, "").trim() || "还没有执行结果" }) },
          { label: "编辑命令", run: () => editStep(planStep || step) },
          { label: stepOff ? "启用这一步" : "禁用这一步", run: () => toggleStep(planStep, !stepOff) },
          { label: "删除这条命令", run: () => deleteCommand(planStep || step) },
        ],
      };
      nodes.push(place(child));
      edges.push([previous, child, step.status === "failed" ? "failed" : step.status === "success" ? "success" : ""]);
      previous = child;
    });
    appendResult(nodes, edges, previous, "result-" + host.id, disabled ? [] : sourceSteps, !disabled && hostSteps.length > 0, host.id, disabled);
    const rowIds = ["host-" + host.id, "result-" + host.id].concat(sourceSteps.map((_, index) => "step-" + host.id + "-" + index));
    const rowHeight = Math.max(34, ...rowIds.map((id) => (sizes[id] && sizes[id].h) || 58));
    hostY += rowHeight + 14;
  }
  if (!planHosts().length && plan) {
    let previous = root;
    plan.steps.forEach((step, index) => {
      const child = {
        id: "step-plan-" + index,
        x: 360 + index * 290,
        y: 72,
        kicker: (index + 1) + " · " + stepCaption(step),
        title: step.command || step.local_path || "未填写",
        sub: step.remote_path || "",
        onClick: () => editStep(step, index),
        actions: [
          { label: "查看命令", run: () => openViewer({ title: "完整命令", kicker: "查看", sub: "", badge: "", log: step.command || "" }) },
          { label: "编辑命令", run: () => editStep(step) },
          { label: "删除这条命令", run: () => deleteCommand(step) },
        ],
      };
      nodes.push(place(child));
      edges.push([previous, child, ""]);
      previous = child;
    });
    appendResult(nodes, edges, previous, "result-plan", plan.steps);
  }
  const width = Math.max(1100, ...nodes.map((node) => node.x + 280));
  const height = Math.max(640, ...nodes.map((node) => node.y + 220));
  return { nodes, edges, width, height };
}

function draw() {
  const board = document.querySelector("#board");
  graph = buildGraph();
  board.style.width = graph.width + "px";
  board.style.height = graph.height + "px";
  applyZoom();
  board.innerHTML = "";
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.classList.add("wires");
  svg.setAttribute("width", graph.width);
  svg.setAttribute("height", graph.height);
  for (const [from, to, tone] of graph.edges) curve(svg, from, to, tone);
  board.append(svg);
  for (const node of graph.nodes) board.append(nodeElement(node));
  const banner = document.querySelector("#banner");
  const viewport = document.querySelector("#viewport");
  if (runDetail && (runDetail.status === "failed" || runDetail.status === "cancelled")) {
    banner.style.display = "block";
    banner.textContent = runDetail.message || "执行已停止";
    viewport.style.height = "calc(100% - 98px)";
  } else {
    banner.style.display = "none";
    viewport.style.height = "calc(100% - 64px)";
  }
  document.querySelector("#cancel-run").disabled = !runDetail || runDetail.status !== "running";
}

function renderSelect() {
  const select = document.querySelector("#plan-select");
  const previous = planId;
  select.innerHTML = "";
  for (const plan of state.plans) {
    const option = document.createElement("option");
    option.value = plan.id;
    option.textContent = plan.name;
    select.append(option);
  }
  if (previous && state.plans.some((plan) => String(plan.id) === String(previous))) select.value = previous;
  planId = select.value || null;
  if (planId) localStorage.setItem("deploy-plan-id", planId);
  else localStorage.removeItem("deploy-plan-id");
}

async function loadState() {
  state = await api("/api/state");
  const parallel = state.settings && state.settings.maxParallelLines;
  if (parallel) document.querySelector("#max-parallel").value = parallel;
  renderSelect();
  restoreView();
  draw();
}

function editPlanName() {
  const plan = currentPlan();
  if (!plan) return ensurePlan().then(draw).catch((error) => alert(error.message));
  const owns = currentUser && (currentUser.isAdmin || String(plan.owner_id) === String(currentUser.id));
  openPanel("项目", [{ label: "名称", name: "name", value: plan.name }], async (values) => {
    await savePlan({ id: plan.id, name: values.name });
  }, owns ? async () => {
    await api("/api/plans/" + plan.id, { method: "DELETE" });
    planId = null;
    document.querySelector("#panel").hidden = true;
    await loadState();
  } : null);
}

function editHost(host) {
  openPanel("目标机器", [
    { label: "名称", name: "name", value: host.name },
    { label: "IP 地址", name: "ip", value: host.ip },
    { label: "端口", name: "port", type: "number", value: host.port },
    { label: "用户名", name: "username", value: host.username },
    { label: "私钥路径，可留空", name: "identityFile", value: host.identity_file || "" },
    { label: "登录密码，留空表示不修改", name: "password", value: "" },
  ], async (values) => {
    await api("/api/hosts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: host.id, ...values, port: Number(values.port || 22), password: values.password || "" }),
    });
    await loadState();
  }, async () => {
    await api("/api/hosts/" + host.id, { method: "DELETE" });
    document.querySelector("#panel").hidden = true;
    await loadState();
  });
}

async function toggleStep(step, disabled) {
  if (!step || !step.id) {
    alert("没有找到这个步骤");
    return;
  }
  await api("/api/steps/disabled", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id: step.id, disabled }),
  });
  await loadState();
}

async function deleteCommand(step) {
  const plan = currentPlan();
  const current = plan && plan.steps.find((item) => Number(item.id) === Number(step.step_id || step.id));
  if (!current) {
    alert("没有找到这个节点，请刷新后再删除");
    return;
  }
  if (!confirm("删除这条命令？同一条线上的其他命令会保留。")) return;
  await api("/api/steps/" + current.id, { method: "DELETE" });
  document.querySelector("#panel").hidden = true;
  await loadState();
}

function editStep(step) {
  const plan = currentPlan();
  const current = plan && plan.steps.find((item) => item.id === step.id);
  if (!current) return;
  const fields = [
    { label: "说明，会替换节点上的「" + (kindLabel[current.kind] || "命令") + "」", name: "note", value: current.note || "" },
  ].concat(current.kind === "remote"
    ? [{ label: "这条线在目标机器上执行的命令", name: "command", type: "textarea", value: current.command }]
    : [
        { label: current.kind === "upload" ? "本机文件或文件夹路径" : "本机路径", name: "localPath", value: current.local_path },
        { label: current.kind === "upload" ? "目标目录" : "目标路径", name: "remotePath", value: current.remote_path },
      ]);
  openPanel(kindLabel[current.kind], fields, async (values) => {
    await api("/api/steps", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: current.id,
        planId: plan.id,
        hostId: current.host_id,
        kind: current.kind,
        command: values.command || "",
        localPath: values.localPath || "",
        remotePath: values.remotePath || "",
        note: values.note || "",
      }),
    });
    const commandText = values.command || values.localPath || "";
    const apply = (steps) => (steps || []).map((item) => Number(item.step_id) === Number(current.id) || Number(item.id) === Number(current.id)
      ? { ...item, command: commandText, preview: commandText, note: values.note || "" }
      : item);
    Object.keys(lineStatus).forEach((key) => { lineStatus[key] = apply(lineStatus[key]); });
    Object.keys(lineView).forEach((key) => {
      if (lineView[key]) lineView[key].steps = apply(lineView[key].steps);
    });
    saveView();
    await loadState();
  }, async () => {
    await api("/api/steps/" + current.id, { method: "DELETE" });
    document.querySelector("#panel").hidden = true;
    await loadState();
  });
}

document.querySelector("#plan-select").onchange = (event) => {
  planId = event.target.value;
  if (planId) localStorage.setItem("deploy-plan-id", planId);
  runDetail = null;
  restoreView();
  draw();
};

document.querySelector("#copy-plan").onclick = async () => {
  try {
    const plan = currentPlan();
    if (!plan) throw new Error("请先选择要复制的画布");
    const saved = await api("/api/plans/copy", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: plan.id }),
    });
    planId = saved.id;
    await loadState();
  } catch (error) {
    alert(error.message);
  }
};

async function copyLine(host) {
  const plan = await ensurePlan();
  await api("/api/lines/copy", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ planId: plan.id, hostId: host.id }),
  });
  await loadState();
}

async function setAllLines(disabled) {
  try {
    const plan = currentPlan();
    if (!plan) throw new Error("请先选择项目");
    await api("/api/line-flags/all", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ planId: Number(plan.id), disabled }),
    });
    await loadState();
  } catch (error) {
    alert(error.message);
  }
}

async function toggleLine(host, disabled) {
  const plan = await ensurePlan();
  await api("/api/line-flags", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ planId: plan.id, hostId: host.id, disabled }),
  });
  await loadState();
}

document.querySelector("#new-plan").onclick = () => createPlan().then(draw).catch((error) => alert(error.message));

document.querySelector("#add-host").onclick = () => {
  if (!currentPlan()) {
    alert("请先选择或新建项目");
    return;
  }
  openPanel("新目标", [
    { label: "名称", name: "name", placeholder: "应用服务器" },
    { label: "IP 地址", name: "ip", placeholder: "10.0.0.12" },
    { label: "端口", name: "port", type: "number", value: "22" },
    { label: "用户名", name: "username", value: "root" },
    { label: "私钥路径，可留空", name: "identityFile" },
    { label: "登录密码，没有密钥时填写", name: "password" },
  ], async (values) => {
    await api("/api/hosts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...values, port: Number(values.port || 22), password: values.password || "", planId: currentPlan() && currentPlan().id }),
    });
    await loadState();
  });
};

async function addStep(kind, hostId) {
  try {
    const plan = await ensurePlan();
    let target = hostId;
    if (!target) {
      if (!state.hosts.length) throw new Error("请先添加目标机器，命令会加到对应的那一条线上");
      if (state.hosts.length === 1) target = state.hosts[0].id;
      else {
        const picked = prompt("要加到哪台机器？填写 IP 或名称\n" + state.hosts.map((host) => host.name + " " + host.ip).join("\n"));
        const host = state.hosts.find((item) => item.ip === picked || item.name === picked);
        if (!host) throw new Error("没有找到这条线");
        target = host.id;
      }
    }
    await api("/api/steps", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        planId: plan.id,
        hostId: Number(target),
        kind,
        command: kind === "remote" ? "echo 新命令" : "",
        localPath: kind === "remote" ? "" : "/tmp/file",
        remotePath: kind === "remote" ? "" : "/tmp/file",
      }),
    });
    await loadState();
  } catch (error) {
    alert(error.message);
  }
}


function resetLineLayout(hostId) {
  const plan = currentPlan();
  const hostNode = graph && graph.nodes.find((item) => item.id === "host-" + hostId);
  const savedHost = positions["host-" + hostId];
  const y = hostNode ? hostNode.y : savedHost && savedHost.y;
  const x = hostNode ? hostNode.x : savedHost ? savedHost.x : 360;
  const prefix = "step-" + hostId + "-";
  Object.keys(positions).forEach((key) => {
    if (key === "host-" + hostId || key === "result-" + hostId || key.startsWith(prefix)) delete positions[key];
  });
  const steps = plan ? plan.steps.filter((step) => String(step.host_id) === String(hostId)) : [];
  steps.forEach((step) => delete positions["step-keep-" + step.id]);
  if (y !== undefined && y !== null) {
    positions["host-" + hostId] = { x, y };
    steps.forEach((step, index) => {
      const pos = { x: x + 340 + index * 290, y };
      positions[prefix + index] = pos;
      positions["step-keep-" + step.id] = pos;
    });
    positions["result-" + hostId] = { x: x + 340 + steps.length * 290, y };
  }
  localStorage.setItem("deploy-node-pos", JSON.stringify(positions));
}

function resetAllLineLayouts() {
  const plan = currentPlan();
  const hostIds = planHosts().map((host) => String(host.id));
  const stepIds = new Set((plan ? plan.steps : []).map((step) => String(step.id)));
  Object.keys(positions).forEach((key) => {
    if (key === "root") delete positions[key];
    if (key.startsWith("step-keep-") && stepIds.has(key.slice("step-keep-".length))) delete positions[key];
    hostIds.forEach((hostId) => {
      if (key === "host-" + hostId || key === "result-" + hostId || key.startsWith("step-" + hostId + "-")) delete positions[key];
    });
  });
  localStorage.setItem("deploy-node-pos", JSON.stringify(positions));
}

function runInProgress() {
  if (runDetail && runDetail.status === "running") return true;
  return !!(state && state.busy);
}

async function refreshAllLines() {
  if (runInProgress()) return;
  const plan = await ensurePlan();
  for (const host of planHosts()) {
    await api("/api/line-flags", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ planId: Number(plan.id), hostId: Number(host.id), forceRun: true }),
    });
    const previous = lineView[host.id] || lineView[String(host.id)] || {};
    lineStatus[host.id] = [];
    lineView[host.id] = { steps: [], cleared: true, finishedAt: previous.finishedAt || "" };
  }
  saveView();
  resetAllLineLayouts();
  draw();
}

async function refreshLine(host) {
  try {
    const plan = currentPlan();
    if (!plan) throw new Error("请先选择项目");
    resetLineLayout(host.id);
    await api("/api/line-flags", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ planId: Number(plan.id), hostId: Number(host.id), forceRun: true }),
    });
    const previous = lineView[host.id] || lineView[String(host.id)] || {};
    lineStatus[host.id] = [];
    lineView[host.id] = { steps: [], cleared: true, finishedAt: previous.finishedAt || "" };
    saveView();
    draw();
  } catch (error) {
    alert(error.message);
  }
}

async function runLine(hostId, fromStepId) {
  try {
    const plan = await ensurePlan();
    const body = { planId: Number(plan.id), hostIds: [Number(hostId)], maxParallel: Math.max(1, Number(document.querySelector("#max-parallel").value) || 1) };
    if (fromStepId) body.fromStepId = Number(fromStepId);
    const result = await api("/api/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    watchRun(result.id);
  } catch (error) {
    alert(error.message);
  }
}

async function runLineUnused(hostId) {
  try {
    const plan = await ensurePlan();
    const result = await api("/api/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ planId: Number(plan.id), hostIds: [Number(hostId)] }),
    });
    watchRun(result.id);
  } catch (error) {
    alert(error.message);
  }
}

async function deleteLine(host) {
  if (!confirm("删除 " + host.name + " 这条线？这台机器和它自己的命令都会去掉。")) return;
  await api("/api/hosts/" + host.id, { method: "DELETE" });
  document.querySelector("#panel").hidden = true;
  await loadState();
}

document.querySelector("#start-run").onclick = async () => {
  try {
    const plan = await ensurePlan();
    const hosts = planHosts();
    if (!hosts.length) throw new Error("请先添加目标机器");
    const maxParallel = Math.max(1, Number(document.querySelector("#max-parallel").value) || 1);
    const result = await api("/api/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ planId: Number(plan.id), hostIds: hosts.map((host) => host.id), maxParallel }),
    });
    watchRun(result.id);
  } catch (error) {
    alert(error.message);
  }
};

document.querySelector("#cancel-run").onclick = async () => {
  if (!runDetail) return;
  await api("/api/runs/" + runDetail.id + "/cancel", { method: "POST" });
};

async function watchRun(id) {
  runDetail = await api("/api/runs/" + id);
  const grouped = {};
  for (const step of runDetail.steps) {
    const key = Number(step.host_id);
    if (!grouped[key]) grouped[key] = [];
    grouped[key].push(step);
  }
  for (const key of Object.keys(grouped)) {
    const steps = grouped[key];
    lineStatus[key] = steps;
    const finished = steps.length > 0 && steps.every((step) => step.status === "success" || step.status === "failed" || step.status === "skipped");
    const previous = lineView[key] || {};
    const finishedAt = finished ? ((steps.slice().reverse().find((step) => step.finished_at) || {}).finished_at || previous.finishedAt || "") : (previous.finishedAt || "");
    lineView[key] = { steps, cleared: false, finishedAt };
  }
  saveView();
  draw();
  if (runDetail.status === "running") {
    clearTimeout(timer);
    timer = setTimeout(() => watchRun(id), 1000);
  }
}

const viewport = document.querySelector("#viewport");
let dragging = false;
let last = [0, 0];
viewport.addEventListener("pointerdown", (event) => {
  if (event.target !== viewport && event.target !== document.querySelector("#board") && event.target.tagName !== "svg") return;
  dragging = true;
  viewport.classList.add("grabbing");
  last = [event.clientX, event.clientY];
});
window.addEventListener("pointerup", () => {
  dragging = false;
  viewport.classList.remove("grabbing");
});
window.addEventListener("pointermove", (event) => {
  if (!dragging) return;
  viewport.scrollLeft -= event.clientX - last[0];
  viewport.scrollTop -= event.clientY - last[1];
  last = [event.clientX, event.clientY];
});

document.addEventListener("pointerdown", (event) => {
  if (!event.target.closest(".node")) {
    document.querySelectorAll(".node.menu-open").forEach((node) => node.classList.remove("menu-open"));
  }
});

document.querySelector("#zoom-in").onclick = () => { zoom += 0.1; applyZoom(); };
document.querySelector("#zoom-out").onclick = () => { zoom -= 0.1; applyZoom(); };
document.querySelector("#viewport").addEventListener("wheel", (event) => {
  if (!event.ctrlKey) return;
  event.preventDefault();
  zoom += event.deltaY < 0 ? 0.1 : -0.1;
  applyZoom();
}, { passive: false });
applyZoom();
document.querySelector("#login-form").onsubmit = async (event) => {
  event.preventDefault();
  const values = Object.fromEntries(new FormData(event.target).entries());
  try {
    const user = await api("/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(values),
    });
    showApp(user);
    await loadState();
  } catch (error) {
    document.querySelector("#login-error").textContent = error.message;
  }
};
document.querySelector("#logout").onclick = async () => {
  await api("/api/logout", { method: "POST" });
  showLogin();
};
document.querySelector("#change-password").onclick = () => {
  openPanel("修改密码", [
    { name: "current", label: "当前密码", type: "password" },
    { name: "password", label: "新密码", type: "password" },
  ], async (values) => {
    await api("/api/password", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(values),
    });
    showLogin();
    alert("密码已修改，请重新登录");
  });
};

function applySide() {
  const hidden = localStorage.getItem("deploy-side") === "hidden";
  document.querySelector("#side").hidden = hidden;
  document.querySelector("#side-show").hidden = !hidden;
}
document.querySelector("#side-hide").onclick = () => {
  localStorage.setItem("deploy-side", "hidden");
  applySide();
};
document.querySelector("#side-show").onclick = () => {
  localStorage.removeItem("deploy-side");
  applySide();
};
applySide();

async function loadUsers() {
  const data = await api("/api/users");
  const list = document.querySelector("#user-list");
  list.innerHTML = "";
  for (const user of data.users) {
    const row = document.createElement("div");
    row.className = "user-row";
    const name = document.createElement("strong");
    name.textContent = user.username + (user.isAdmin ? "（管理员）" : "");
    row.append(name);
    if (user.isAdmin) {
      const note = document.createElement("span");
      note.textContent = "可以打开全部画布";
      row.append(note);
    } else {
      const grants = document.createElement("div");
      grants.className = "grant-list";
      for (const plan of data.plans) {
        const label = document.createElement("label");
        const box = document.createElement("input");
        box.type = "checkbox";
        box.value = plan.id;
        box.checked = user.planIds.includes(plan.id);
        label.append(box, document.createTextNode(plan.name));
        grants.append(label);
      }
      const save = document.createElement("button");
      save.type = "button";
      save.className = "ghost";
      save.textContent = "保存权限";
      save.onclick = async () => {
        const planIds = [...grants.querySelectorAll("input:checked")].map((box) => Number(box.value));
        await api("/api/users/grants", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ userId: user.id, planIds }),
        });
        alert("已保存");
      };
      row.append(grants, save);
    }
    if (!user.isAdmin) {
      const del = document.createElement("button");
      del.type = "button";
      del.className = "danger";
      del.textContent = "删除";
      del.onclick = async () => {
        if (!confirm("删除用户 " + user.username + "？")) return;
        await api("/api/users/" + user.id, { method: "DELETE" });
        await loadUsers();
      };
      row.append(del);
    }
    list.append(row);
  }
}
document.querySelector("#manage-users").onclick = async () => {
  document.querySelector("#user-screen").hidden = false;
  try { await loadUsers(); } catch (error) { alert(error.message); }
};
document.querySelector("#user-close").onclick = () => { document.querySelector("#user-screen").hidden = true; };
document.querySelector("#user-create").onsubmit = async (event) => {
  event.preventDefault();
  const values = Object.fromEntries(new FormData(event.target).entries());
  try {
    await api("/api/users", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(values),
    });
    event.target.reset();
    await loadUsers();
  } catch (error) {
    alert(error.message);
  }
};

api("/api/me").then(async (user) => {
  showApp(user);
  await loadState();
}).catch(() => showLogin());


function openViewer(node) {
  const viewer = document.querySelector("#viewer");
  viewer.classList.add("open");
  document.querySelector("#viewer-title").textContent = node.title || "远程命令";
  document.querySelector("#viewer-meta").textContent = [node.kicker, node.sub, node.badge].filter(Boolean).join(" · ");
  document.querySelector("#viewer-log").textContent = node.log || "";
}

document.querySelector("#viewer-close").onclick = () => {
  document.querySelector("#viewer").classList.remove("open");
};

(() => {
  const viewer = document.querySelector("#viewer");
  const handle = viewer.querySelector("header");
  let moving = false;
  let origin = [0, 0, 0, 0];
  handle.addEventListener("pointerdown", (event) => {
    if (event.target.closest("button")) return;
    moving = true;
    origin = [event.clientX, event.clientY, viewer.offsetLeft, viewer.offsetTop];
    handle.setPointerCapture(event.pointerId);
  });
  handle.addEventListener("pointermove", (event) => {
    if (!moving) return;
    viewer.style.left = origin[2] + event.clientX - origin[0] + "px";
    viewer.style.top = origin[3] + event.clientY - origin[1] + "px";
  });
  handle.addEventListener("pointerup", () => {
    moving = false;
  });
})();
let aiDraft = null;
const kindText = { remote: "命令", upload: "上传", download: "下载" };
function openAiDraft() {
  aiDraft = null;
  document.querySelector("#ai-preview").innerHTML = "";
  document.querySelector("#ai-save").hidden = true;
  document.querySelector("#ai-screen").hidden = false;
}
document.querySelector("#ai-close").onclick = () => { document.querySelector("#ai-screen").hidden = true; };
(function enableAiDrag() {
  const screen = document.querySelector("#ai-screen");
  const card = screen.querySelector(".user-card");
  card.addEventListener("pointerdown", (event) => {
    if (event.target.closest("button, textarea, input, a")) return;
    const rect = card.getBoundingClientRect();
    const offsetX = event.clientX - rect.left;
    const offsetY = event.clientY - rect.top;
    card.setPointerCapture(event.pointerId);
    screen.classList.add("dragging");
    const move = (ev) => {
      const x = Math.min(window.innerWidth - 120, Math.max(8, ev.clientX - offsetX));
      const y = Math.min(window.innerHeight - 80, Math.max(8, ev.clientY - offsetY));
      card.style.left = x + "px";
      card.style.top = y + "px";
      card.style.right = "auto";
      card.style.transform = "none";
    };
    const up = (ev) => {
      screen.classList.remove("dragging");
      try { card.releasePointerCapture(ev.pointerId); } catch (error) {}
      card.removeEventListener("pointermove", move);
      card.removeEventListener("pointerup", up);
    };
    card.addEventListener("pointermove", move);
    card.addEventListener("pointerup", up);
  });
})();
document.querySelector("#ai-generate").onclick = async () => {
  try {
    const plan = await ensurePlan();
    const button = document.querySelector("#ai-generate");
    button.disabled = true;
    aiDraft = await api("/api/ai/draft", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ planId: Number(plan.id), prompt: document.querySelector("#ai-prompt").value }),
    });
    const box = document.querySelector("#ai-preview");
    box.innerHTML = "";
    const summary = document.createElement("p");
    summary.textContent = aiDraft.summary || "草稿已生成";
    box.append(summary);
    (aiDraft.warnings || []).forEach((warning) => {
      const line = document.createElement("p");
      line.textContent = warning;
      box.append(line);
    });
    aiDraft.lines.forEach((line) => {
      const title = document.createElement("strong");
      title.textContent = line.hostName;
      box.append(title);
      line.steps.forEach((step, index) => {
        const item = document.createElement("div");
        const text = step.kind === "remote" ? step.command : step.localPath + " -> " + step.remotePath;
        item.textContent = line.action === "disable"
          ? "禁用：" + (step.note || text)
          : (index + 1) + ". " + (kindText[step.kind] || step.kind) + (step.note ? " " + step.note : "") + "：" + text;
        box.append(item);
      });
    });
    document.querySelector("#ai-save").hidden = false;
  } catch (error) {
    alert(error.message);
  } finally {
    document.querySelector("#ai-generate").disabled = false;
  }
};
document.querySelector("#ai-save").onclick = async () => {
  if (!aiDraft) return;
  try {
    await api("/api/ai/apply", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ planId: Number(aiDraft.planId), lines: aiDraft.lines }),
    });
    document.querySelector("#ai-screen").hidden = true;
    await loadState();
    alert("已保存。复制出来的是整条新线，在画布底部。如需取消，可再次打开 AI 起草并点撤回上次保存。");
  } catch (error) {
    alert(error.message);
  }
};
document.querySelector("#ai-undo").onclick = async () => {
  try {
    const plan = currentPlan();
    if (!plan) throw new Error("请先选择项目");
    await api("/api/ai/undo", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ planId: Number(plan.id) }),
    });
    await loadState();
    alert("已撤回上次 AI 保存");
  } catch (error) {
    alert(error.message);
  }
};

document.querySelector("#ai-config").onclick = async () => {
  const cfg = await api("/api/ai/config");
  const form = document.querySelector("#ai-config-form");
  form.base_url.value = cfg.base_url || "";
  form.api_key.value = cfg.api_key || "";
  form.model.value = cfg.model || "";
  form.timeout.value = cfg.timeout || 60;
  document.querySelector("#ai-config-screen").hidden = false;
};
document.querySelector("#ai-config-close").onclick = () => {
  document.querySelector("#ai-config-screen").hidden = true;
};
document.querySelector("#ai-config-form").onsubmit = async (event) => {
  event.preventDefault();
  const values = Object.fromEntries(new FormData(event.target).entries());
  try {
    await api("/api/ai/config", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(values),
    });
    document.querySelector("#ai-config-screen").hidden = true;
  } catch (error) {
    alert(error.message);
  }
};

function renderPlanManager() {
  const list = document.querySelector("#plan-list");
  list.innerHTML = "";
  if (!state.plans.length) {
    list.textContent = "还没有项目";
    return;
  }
  state.plans.forEach((plan) => {
    const row = document.createElement("div");
    row.className = "user-row";
    const name = document.createElement("strong");
    name.textContent = plan.name;
    const del = document.createElement("button");
    del.type = "button";
    del.className = "danger";
    del.textContent = "删除";
    del.onclick = async () => {
      const typed = prompt("请输入项目名称以确认删除", "");
      if (typed === null) return;
      if (typed.trim() !== plan.name) {
        alert("项目名称不一致，未删除");
        return;
      }
      try {
        await api("/api/plans/" + plan.id, { method: "DELETE" });
        if (String(planId) === String(plan.id)) planId = null;
        await loadState();
        renderPlanManager();
      } catch (error) {
        alert(error.message);
      }
    };
    row.append(name, del);
    list.append(row);
  });
}
document.querySelector("#manage-plans").onclick = async () => {
  await loadState();
  renderPlanManager();
  document.querySelector("#plan-screen").hidden = false;
};
document.querySelector("#plan-close").onclick = () => {
  document.querySelector("#plan-screen").hidden = true;
};
