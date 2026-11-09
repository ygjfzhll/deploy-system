const fs = require("fs");
const py = "D:/tmp/deploy-system/app.py";
const js = "D:/tmp/deploy-system/public/app.js";
let p = fs.readFileSync(py, "utf8");
if (!p.includes("def latest_step")) {
  p = p.replace(
    "def execute_run(run_id):",
    `def latest_step(step):
    if not step or not step.get("id"):
        return step
    with connect() as conn:
        row = conn.execute("SELECT * FROM steps WHERE id=?", (step["id"],)).fetchone()
    return dict(row) if row else step


def execute_run(run_id):`
  );
  p = p.replace(
    "        step = steps.get(item[\"step_id\"])\n        update_step(item[\"id\"], status=\"running\", started_at=now())\n",
    "        step = latest_step(steps.get(item[\"step_id\"]))\n        update_step(item[\"id\"], status=\"running\", started_at=now())\n"
  );
  fs.writeFileSync(py, p);
}
let j = fs.readFileSync(js, "utf8");
if (!j.includes("function liveCommand")) {
  j = j.replace(
    "function stepCaption(step, planStep) {",
    `function liveCommand(step, planStep) {
  if (planStep && (planStep.command || planStep.local_path)) return planStep.command || planStep.local_path;
  return step.command || step.preview || step.local_path || "未填写";
}

function stepCaption(step, planStep) {`
  );
  j = j.replace(
`    sourceSteps.forEach((step, index) => {
      const child = {
        id: "step-" + host.id + "-" + index,
        x: 700 + index * 290,
        y: hostY,
        kicker: (step.position || index + 1) + " · " + stepCaption(step, ownSteps.find((item) => item.id === (step.step_id || step.id)) || ownSteps[index]),
        title: step.preview || step.command || step.local_path || "未填写",`,
`    sourceSteps.forEach((step, index) => {
      const planStep = ownSteps.find((item) => item.id === (step.step_id || step.id)) || ownSteps[index];
      const commandText = liveCommand(step, planStep);
      const child = {
        id: "step-" + host.id + "-" + index,
        x: 700 + index * 290,
        y: hostY,
        kicker: (step.position || index + 1) + " · " + stepCaption(step, planStep),
        title: commandText,`
  );
  j = j.replace(
    "log: (ownSteps[index] || step).command || step.preview || step.command || \"\"",
    "log: commandText"
  );
  j = j.replace(
`        note: values.note || "",
      }),
    });
    await loadState();`,
`        note: values.note || "",
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
    await loadState();`
  );
  fs.writeFileSync(js, j);
}
fs.copyFileSync(py, "C:/Users/jiuzhou/Documents/Codex/2026-10-29/new-chat-3/deploy-system/app.py");
fs.copyFileSync(js, "C:/Users/jiuzhou/Documents/Codex/2026-10-29/new-chat-3/deploy-system/public/app.js");
console.log("ok");
