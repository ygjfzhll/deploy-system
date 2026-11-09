const fs = require("fs");
const p = "D:/tmp/deploy-system/public/app.js";
let c = fs.readFileSync(p, "utf8");
c = c.replace(
`      name,
      steps: [{ kind: "remote", command: "echo 已连接", localPath: "", remotePath: "" }],`,
`      name,`
);
c = c.replace(
`    await savePlan({ id: plan.id, name: values.name }, stepsPayload(plan));`,
`    await savePlan({ id: plan.id, name: values.name });`
);
c = c.replace(
`async function savePlan(plan, steps) {
  const saved = await api("/api/plans", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id: plan.id, name: plan.name, steps }),
  });`,
`async function savePlan(plan, steps) {
  const body = { id: plan.id, name: plan.name };
  if (steps) body.steps = steps;
  const saved = await api("/api/plans", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });`
);
fs.writeFileSync(p, c);
console.log("fixed", !c.includes("echo 已连接"));
