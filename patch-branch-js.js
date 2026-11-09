const fs = require("fs");
const p = "D:/tmp/deploy-system/public/app.js";
let c = fs.readFileSync(p, "utf8");
c = c.replace(
`      body: JSON.stringify({
      name,
      steps: [{ kind: "remote", command: "echo 已连接", localPath: "", remotePath: "" }],
    }),`,
`      body: JSON.stringify({ name }),`
);
c = c.replace(
`    const sourceSteps = hostSteps.length ? hostSteps : (plan ? plan.steps.map((step, index) => ({ ...step, position: index + 1, preview: step.command || step.local_path, status: "" })) : []);`,
`    const ownSteps = plan ? plan.steps.filter((step) => String(step.host_id) === String(host.id)) : [];
    const sourceSteps = hostSteps.length ? hostSteps : ownSteps.map((step, index) => ({ ...step, position: index + 1, preview: step.command || step.local_path, status: "" }));`
);
c = c.replace(
`        onClick: () => editStep(plan.steps[index] || step, index),`,
`        onClick: () => editStep(ownSteps[index] || step),`
);
const oldEdit = `function editStep(step, index) {
  const plan = currentPlan();
  if (!plan || !plan.steps[index]) return;
  const current = plan.steps[index];
  const fields = current.kind === "remote"
    ? [{ label: "在目标机器上执行的命令", name: "command", type: "textarea", value: current.command }]
    : [
        { label: "本机路径", name: "localPath", value: current.local_path },
        { label: "目标路径", name: "remotePath", value: current.remote_path },
      ];
  openPanel(kindLabel[current.kind], fields, async (values) => {
    const steps = stepsPayload(plan);
    steps[index] = { ...steps[index], ...values };
    await savePlan(plan, steps);
  }, async () => {
    const steps = stepsPayload(plan);
    steps.splice(index, 1);
    if (!steps.length) return alert("至少保留一条命令");
    await savePlan(plan, steps);
    document.querySelector("#panel").hidden = true;
  });
}`;
const newEdit = `function editStep(step) {
  const plan = currentPlan();
  const current = plan && plan.steps.find((item) => item.id === step.id);
  if (!current) return;
  const fields = current.kind === "remote"
    ? [{ label: "这条线在目标机器上执行的命令", name: "command", type: "textarea", value: current.command }]
    : [
        { label: "本机路径", name: "localPath", value: current.local_path },
        { label: "目标路径", name: "remotePath", value: current.remote_path },
      ];
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
      }),
    });
    await loadState();
  }, async () => {
    await api("/api/steps/" + current.id, { method: "DELETE" });
    document.querySelector("#panel").hidden = true;
    await loadState();
  });
}`;
if (!c.includes(oldEdit)) throw new Error("editStep missing");
c = c.replace(oldEdit, newEdit);
const oldAdd = `async function addStep(kind) {
  try {
    const plan = await ensurePlan();
    const extra = kind === "remote"
      ? { kind, command: "echo 新命令", localPath: "", remotePath: "" }
      : { kind, command: "", localPath: "/tmp/file", remotePath: "/tmp/file" };
    await savePlan(plan, stepsPayload(plan, extra));
  } catch (error) {
    alert(error.message);
  }
}

document.querySelector("#add-step").onclick = () => addStep("remote");
document.querySelector("#add-upload").onclick = () => addStep("upload");
document.querySelector("#add-download").onclick = () => addStep("download");`;
const newAdd = `async function addStep(kind, hostId) {
  try {
    const plan = await ensurePlan();
    let target = hostId;
    if (!target) {
      if (!state.hosts.length) throw new Error("请先添加目标机器，命令会加到对应的那一条线上");
      if (state.hosts.length === 1) target = state.hosts[0].id;
      else {
        const picked = prompt("要加到哪台机器？填写 IP 或名称\\n" + state.hosts.map((host) => host.name + " " + host.ip).join("\\n"));
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
document.querySelector("#add-download").onclick = () => addStep("download");`;
if (!c.includes(oldAdd)) throw new Error("addStep missing");
c = c.replace(oldAdd, newAdd);
c = c.replace(
`      onClick: () => editHost(host),
    };`,
`      onClick: () => editHost(host),
      actions: [
        { label: "加命令", run: () => addStep("remote", host.id) },
        { label: "加上传", run: () => addStep("upload", host.id) },
      ],
    };`
);
const oldNodeEnd = `  el.append(kicker, title, sub);`;
const newNodeEnd = `  el.append(kicker, title, sub);
  if (node.actions) {
    const bar = document.createElement("div");
    bar.className = "node-actions";
    for (const action of node.actions) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "zoom";
      button.textContent = action.label;
      button.onclick = (event) => {
        event.stopPropagation();
        action.run();
      };
      bar.append(button);
    }
    el.append(bar);
  }`;
if (!c.includes(oldNodeEnd)) throw new Error("node append missing");
c = c.replace(oldNodeEnd, newNodeEnd);
fs.writeFileSync(p, c);
console.log("js ok");
