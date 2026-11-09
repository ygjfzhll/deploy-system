const fs = require("fs");
const pyPath = "D:/tmp/deploy-system/app.py";
let py = fs.readFileSync(pyPath, "utf8");
if (!py.includes("def latest_line")) {
  py = py.replace(
    "def run_detail(run_id):",
    `def latest_line(plan_id, host_id):
    with connect() as conn:
        host = conn.execute("SELECT * FROM hosts WHERE id=?", (host_id,)).fetchone()
        if not host:
            return None
        run = conn.execute(
            """
            SELECT runs.* FROM runs
            JOIN run_steps ON run_steps.run_id = runs.id
            WHERE runs.plan_id=? AND run_steps.host_id=?
            ORDER BY runs.id DESC
            LIMIT 1
            """,
            (plan_id, host_id),
        ).fetchone()
        if not run:
            return {"id": None, "status": "", "message": "", "steps": []}
        data = dict(run)
        data["steps"] = rows(
            conn,
            "SELECT * FROM run_steps WHERE run_id=? AND host_id=? ORDER BY position, id",
            (run["id"], host_id),
        )
        return data


def run_detail(run_id):`
  );
  py = py.replace(
    'if path == "/api/state":\n            return self.send_json(public_state())\n',
    `if path == "/api/state":
            return self.send_json(public_state())
        if path.startswith("/api/lines/"):
            from urllib.parse import parse_qs
            try:
                host_id = int(path.rstrip("/").rsplit("/", 1)[-1])
                plan_id = int(parse_qs(urlparse(self.path).query).get("planId", ["0"])[0])
            except ValueError:
                return self.send_json({"error": "无效参数"}, 400)
            data = latest_line(plan_id, host_id)
            if data is None:
                return self.send_json({"error": "目标不存在"}, 404)
            return self.send_json(data)
`
  );
}
fs.writeFileSync(pyPath, py);

const jsPath = "D:/tmp/deploy-system/public/app.js";
let js = fs.readFileSync(jsPath, "utf8");
if (!js.includes("let lineStatus")) {
  js = js.replace("let runDetail = null;", "let runDetail = null;\nlet lineStatus = {};");
}
js = js.replace(
`        { label: "执行这条线", run: () => runLine(host.id) },`,
`        { label: "刷新这条线", run: () => refreshLine(host) },
        { label: "执行这条线", run: () => runLine(host.id) },`
);
js = js.replace(
  "const hostSteps = runDetail ? runDetail.steps.filter((step) => step.host_label.includes(host.ip)) : [];",
  "const hostSteps = lineStepsFor(host);"
);
if (!js.includes("function lineStepsFor")) {
  js = js.replace(
    "function resultState(steps, inThisRun) {",
    `function lineStepsFor(host) {
  if (Object.prototype.hasOwnProperty.call(lineStatus, host.id)) return lineStatus[host.id];
  if (!runDetail) return [];
  return runDetail.steps.filter((step) => Number(step.host_id) === Number(host.id));
}

function resultState(steps, inThisRun) {`
  );
}
if (!js.includes("async function refreshLine")) {
  js = js.replace(
    "async function runLine(hostId) {",
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
}

async function runLine(hostId) {`
  );
}
js = js.replace(
`async function watchRun(id) {
  runDetail = await api("/api/runs/" + id);
  draw();`,
`async function watchRun(id) {
  runDetail = await api("/api/runs/" + id);
  const grouped = {};
  for (const step of runDetail.steps) {
    const key = Number(step.host_id);
    if (!grouped[key]) grouped[key] = [];
    grouped[key].push(step);
  }
  for (const key of Object.keys(grouped)) lineStatus[key] = grouped[key];
  draw();`
);
fs.writeFileSync(jsPath, js);
console.log("py", py.includes("def latest_line"), "js", js.includes("refreshLine"));
