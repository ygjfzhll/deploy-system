const fs = require("fs");
const jsPath = "D:/tmp/deploy-system/public/app.js";
let js = fs.readFileSync(jsPath, "utf8");
if (!js.includes("删除这条命令")) {
  js = js.replace(
`        log: step.output || "",
        onClick: () => editStep(ownSteps[index] || step),
      };`,
`        log: step.output || "",
        onClick: () => editStep(ownSteps[index] || step),
        actions: [
          { label: "删除这条命令", run: () => deleteCommand(ownSteps[index] || step) },
        ],
      };`
  );
  js = js.replace(
`        onClick: () => editStep(step, index),
      };`,
`        onClick: () => editStep(step, index),
        actions: [
          { label: "删除这条命令", run: () => deleteCommand(step) },
        ],
      };`
  );
  js = js.replace(
    "function editStep(step) {",
    `async function deleteCommand(step) {
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

function editStep(step) {`
  );
  fs.writeFileSync(jsPath, js);
}
fs.copyFileSync(jsPath, "C:/Users/jiuzhou/Documents/Codex/2026-10-29/new-chat-3/deploy-system/public/app.js");
console.log("ok", js.includes("deleteCommand"));
