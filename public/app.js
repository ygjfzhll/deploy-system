let state = { hosts: [], plans: [], runs: [] };
let planId = null;
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
  if (!response.ok) throw new Error(data.error || "请求失败");
  return data;
}

function currentPlan() {
  return state.plans.find((plan) => String(plan.id) === String(planId));
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
    if (field.name === "password") input.type = "password";
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

async function ensurePlan() {
  if (currentPlan()) return currentPlan();
  const name = prompt("方案名称", "发布流程");
  if (!name) throw new Error("请先建立方案");
  const saved = await api("/api/plans", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name,
    }),
  });
  planId = saved.id;
  await loadState();
  return currentPlan();
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
      button.onclick = (event) => {
        event.stopPropagation();
        action.run();
      };
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
    const move = (ev) => {
      const dx = ev.clientX - startX;
      const dy = ev.clientY - startY;
      if (Math.abs(dx) + Math.abs(dy) > 4) moved = true;
      node.x = origX + dx / zoom;
      node.y = origY + dy / zoom;
      el.style.left = node.x + "px";
      el.style.top = node.y + "px";
      positions[node.id] = { x: node.x, y: node.y };
      redrawWires();
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      if (moved) {
        el.dataset.dragged = "1";
        localStorage.setItem("deploy-node-pos", JSON.stringify(positions));
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

function place(node) {
  const saved = positions[node.id];
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

function resultState(steps, inThisRun) {
  if (!inThisRun || !steps.length) return { tone: "", title: "未执行", sub: "这条线还没开始" };
  const errored = steps.some((step) => step.status === "failed" || step.status === "skipped");
  const allSuccess = steps.every((step) => step.status === "success");
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

function redrawWires() {
  const board = document.querySelector("#board");
  const svg = board && board.querySelector("svg.wires");
  if (!svg || !graph) return;
  const width = Math.max(1100, ...graph.nodes.map((node) => node.x + 320));
  const height = Math.max(640, ...graph.nodes.map((node) => node.y + 240));
  board.style.width = width + "px";
  board.style.height = height + "px";
  applyZoom();
  svg.setAttribute("width", width);
  svg.setAttribute("height", height);
  svg.replaceChildren();
  for (const [from, to, tone] of graph.edges) curve(svg, from, to, tone);
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
  const nodes = [];
  const edges = [];
  const root = {
    id: "root",
    x: 48,
    y: 72,
    kicker: "方案",
    title: plan ? plan.name : "还没有方案",
    sub: plan ? plan.steps.length + " 个命令 · " + state.hosts.length + " 台机器" : "点击新建方案",
    tone: "root",
    onClick: () => editPlanName(),
  };
  nodes.push(place(root));
  let hostY = 28;
  for (const host of state.hosts) {
    const disabled = !!(plan && (plan.disabledHostIds || []).some((id) => Number(id) === Number(host.id)));
    const hostNode = {
      id: "host-" + host.id,
      x: 360,
      y: hostY,
      kicker: "目标机器",
      title: host.name,
      sub: host.username + "@" + host.ip + ":" + host.port,
      onClick: () => editHost(host),
      actions: [
        { label: "刷新这条线", run: () => refreshLine(host) },
        { label: "执行这条线", run: () => runLine(host.id) },
        { label: "加命令", run: () => addStep("remote", host.id) },
        { label: "加上传", run: () => addStep("upload", host.id) },
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
    const lineDone = hostSteps.length && hostSteps.every((step) => step.status === "success");
    if (!disabled && failed) hostNode.tone = "failed";
    else if (!disabled && running) hostNode.tone = "running";
    else if (!disabled && lineDone) hostNode.tone = "success";
    if (disabled) hostNode.badge = "已禁用";
    else if (failed || running || lineDone) hostNode.badge = failed ? "失败" : running ? "执行中" : "完成";
    nodes.push(place(hostNode));
    edges.push([root, hostNode, hostNode.tone]);
    let previous = hostNode;
    const ownSteps = plan ? plan.steps.filter((step) => String(step.host_id) === String(host.id)) : [];
    const sourceSteps = hostSteps.length ? hostSteps : ownSteps.map((step, index) => ({ ...step, position: index + 1, preview: step.command || step.local_path, status: "" }));
    sourceSteps.forEach((step, index) => {
      const planStep = ownSteps.find((item) => item.id === (step.step_id || step.id)) || ownSteps[index];
      const commandText = liveCommand(step, planStep);
      const child = {
        id: "step-" + host.id + "-" + index,
        x: 700 + index * 290,
        y: hostY,
        kicker: (step.position || index + 1) + " · " + stepCaption(step, planStep),
        title: commandText,
        sub: step.remote_path || step.host_label || "",
        tone: disabled ? "disabled" : (step.status && step.status !== "pending" ? step.status : ""),
        badge: disabled ? "" : (step.status && step.status !== "pending" ? statusLabel[step.status] : ""),
        log: step.output || "",
        onClick: () => editStep(ownSteps[index] || step),
        actions: [
          ...(step.status === "failed" ? [{ label: "从这里继续", run: () => runLine(host.id, step.step_id || (ownSteps[index] && ownSteps[index].id)) }] : []),
          { label: "查看命令", run: () => openViewer({ title: "完整命令", kicker: "查看", sub: "", badge: "", log: commandText }) },
          { label: "查看执行结果", run: () => openViewer({ title: "执行结果", kicker: "结果", sub: "", badge: "", log: (step.output || "").replace(/本次未重复执行/g, "").trim() || "还没有执行结果" }) },
          { label: "编辑命令", run: () => editStep(ownSteps[index] || step) },
          { label: "删除这条命令", run: () => deleteCommand(ownSteps[index] || step) },
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
  if (!state.hosts.length && plan) {
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
}

async function loadState() {
  state = await api("/api/state");
  renderSelect();
  restoreView();
  draw();
}

function editPlanName() {
  const plan = currentPlan();
  if (!plan) return ensurePlan().then(draw).catch((error) => alert(error.message));
  openPanel("方案", [{ label: "名称", name: "name", value: plan.name }], async (values) => {
    await savePlan({ id: plan.id, name: values.name });
  }, async () => {
    await api("/api/plans/" + plan.id, { method: "DELETE" });
    planId = null;
    document.querySelector("#panel").hidden = true;
    await loadState();
  });
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

async function deleteCommand(step) {
  const plan = currentPlan();
  const current = plan && plan.steps.find((item) => Number(item.id) === Number(step.step_id || step.id));
  if (!current) {
    alert("没有找到这条命令");
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
        { label: "本机路径", name: "localPath", value: current.local_path },
        { label: "目标路径", name: "remotePath", value: current.remote_path },
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

async function toggleLine(host, disabled) {
  const plan = await ensurePlan();
  await api("/api/line-flags", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ planId: plan.id, hostId: host.id, disabled }),
  });
  await loadState();
}

document.querySelector("#new-plan").onclick = () => ensurePlan().then(draw).catch((error) => alert(error.message));

document.querySelector("#add-host").onclick = () => {
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
      body: JSON.stringify({ ...values, port: Number(values.port || 22), password: values.password || "" }),
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

document.querySelector("#add-step").onclick = () => addStep("remote");
document.querySelector("#add-upload").onclick = () => addStep("upload");
document.querySelector("#add-download").onclick = () => addStep("download");

async function refreshLine(host) {
  try {
    const plan = currentPlan();
    if (!plan) throw new Error("请先选择方案");
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
    const body = { planId: Number(plan.id), hostIds: [Number(hostId)] };
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
    if (!state.hosts.length) throw new Error("请先添加目标机器");
    const result = await api("/api/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ planId: Number(plan.id), hostIds: state.hosts.map((host) => host.id) }),
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
loadState().catch((error) => alert(error.message));

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