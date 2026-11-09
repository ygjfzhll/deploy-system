const fs = require("fs");
const p = "D:/tmp/deploy-system/public/app.js";
let c = fs.readFileSync(p, "utf8");
if (!c.includes("let positions")) {
  c = c.replace("let runDetail = null;\n", "let runDetail = null;\nlet graph = null;\nlet positions = JSON.parse(localStorage.getItem(\"deploy-node-pos\") || \"{}\");\n");
}
c = c.replace(
  'path.setAttribute("stroke", tone === "failed" ? "#c5342a" : "#8aa0b8");',
  'path.setAttribute("stroke", tone === "failed" ? "#c5342a" : tone === "success" ? "#1f7a4d" : "#8aa0b8");'
);
const oldClick = `  el.onclick = (event) => {
    event.stopPropagation();
    if (node.onClick) node.onClick();
  };
  return el;
}`;
const newClick = `  el.addEventListener("pointerdown", (event) => {
    if (event.target.closest("button")) return;
    const startX = event.clientX;
    const startY = event.clientY;
    const origX = node.x;
    const origY = node.y;
    let moved = false;
    const move = (ev) => {
      const dx = ev.clientX - startX;
      const dy = ev.clientY - startY;
      if (Math.abs(dx) + Math.abs(dy) > 4) moved = true;
      node.x = origX + dx;
      node.y = origY + dy;
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

function resultState(steps) {
  if (!runDetail || !steps.length) return { tone: "", title: "未执行", sub: "等待开始" };
  const errored = steps.some((step) => step.status === "failed");
  const unfinished = steps.some((step) => step.status === "skipped" || step.status === "pending" || step.status === "running");
  const allSuccess = steps.every((step) => step.status === "success");
  const stopped = runDetail.status === "failed" || runDetail.status === "cancelled";
  if (allSuccess && runDetail.status === "success") return { tone: "success", title: "成功", sub: "前面的命令都已完成" };
  if (errored || unfinished || stopped) return { tone: "failed", title: "失败", sub: errored ? "有命令报错" : "执行未完成已退出" };
  if (runDetail.status === "running") return { tone: "running", title: "执行中", sub: "尚未结束" };
  return { tone: "", title: "未执行", sub: "等待开始" };
}

function appendResult(nodes, edges, previous, id, steps) {
  const stateText = resultState(steps);
  const node = place({
    id,
    x: previous.x + 290,
    y: previous.y,
    kicker: "执行结果",
    title: stateText.title,
    sub: stateText.sub,
    tone: stateText.tone,
    badge: stateText.title,
  });
  nodes.push(node);
  edges.push([previous, node, stateText.tone === "failed" ? "failed" : stateText.tone === "success" ? "success" : ""]);
}

function redrawWires() {
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
}`;
if (!c.includes(oldClick)) throw new Error("click block missing");
if (!c.includes("function place")) c = c.replace(oldClick, newClick);
c = c.replace("  nodes.push(root);", "  nodes.push(place(root));");
c = c.replace(
`      const child = {
        x: 700 + index * 290,
        y: hostY,`,
`      const child = {
        id: "step-" + host.id + "-" + index,
        x: 700 + index * 290,
        y: hostY,`
);
c = c.replace("    nodes.push(hostNode);", "    nodes.push(place(hostNode));");
const hostLoop = `      nodes.push(child);
      edges.push([previous, child, step.status === "failed" ? "failed" : ""]);
      previous = child;
    });`;
const hostLoopNew = `      nodes.push(place(child));
      edges.push([previous, child, step.status === "failed" ? "failed" : step.status === "success" ? "success" : ""]);
      previous = child;
    });
    appendResult(nodes, edges, previous, "result-" + host.id, sourceSteps);`;
if (!c.includes(hostLoop)) throw new Error("host loop missing");
c = c.replace(hostLoop, hostLoopNew);
c = c.replace(
`      const child = {
        x: 360 + index * 290,
        y: 72,`,
`      const child = {
        id: "step-plan-" + index,
        x: 360 + index * 290,
        y: 72,`
);
const planLoop = `      nodes.push(child);
      edges.push([previous, child, ""]);
      previous = child;
    });
  }`;
const planLoopNew = `      nodes.push(place(child));
      edges.push([previous, child, ""]);
      previous = child;
    });
    appendResult(nodes, edges, previous, "result-plan", plan.steps);
  }`;
if (!c.includes(planLoop)) throw new Error("plan loop missing");
c = c.replace(planLoop, planLoopNew);
c = c.replace("  const graph = buildGraph();", "  graph = buildGraph();");
fs.writeFileSync(p, c);
console.log("ok", c.includes("appendResult"), c.includes("graph = buildGraph"));
