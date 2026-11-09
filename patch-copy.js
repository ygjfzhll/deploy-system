const fs = require("fs");
const pyPath = "D:/tmp/deploy-system/app.py";
let py = fs.readFileSync(pyPath, "utf8");
py = py.replaceAll('"-o", "StrictHostKeyChecking=accept-new",', '"-o", "StrictHostKeyChecking=no",\n            "-o", "UserKnownHostsFile=/dev/null",');
if (!py.includes("line_flags")) {
  py = py.replace(
    "assign_legacy_steps(conn)\n",
    `conn.execute(
            """
            CREATE TABLE IF NOT EXISTS line_flags (
              plan_id INTEGER NOT NULL,
              host_id INTEGER NOT NULL,
              disabled INTEGER NOT NULL DEFAULT 0,
              PRIMARY KEY (plan_id, host_id)
            )
            """
        )
        assign_legacy_steps(conn)
`
  );
  py = py.replace(
`        for plan in plans:
            plan["steps"] = rows(
                conn,
                "SELECT * FROM steps WHERE plan_id=? ORDER BY position, id",
                (plan["id"],),
            )
`,
`        flags = rows(conn, "SELECT plan_id, host_id FROM line_flags WHERE disabled=1")
        for plan in plans:
            plan["steps"] = rows(
                conn,
                "SELECT * FROM steps WHERE plan_id=? ORDER BY position, id",
                (plan["id"],),
            )
            plan["disabledHostIds"] = [row["host_id"] for row in flags if row["plan_id"] == plan["id"]]
`
  );
  py = py.replace(
`        hosts = []
        for host_id in host_ids:
            host = conn.execute("SELECT * FROM hosts WHERE id=?", (host_id,)).fetchone()
            if not host:
                raise ValueError(f"目标不存在：{host_id}")
            hosts.append(dict(host))
        if not hosts:
            raise ValueError("请至少选择一台目标机器")
`,
`        disabled = {row["host_id"] for row in conn.execute("SELECT host_id FROM line_flags WHERE plan_id=? AND disabled=1", (plan_id,))}
        hosts = []
        for host_id in host_ids:
            if host_id in disabled:
                continue
            host = conn.execute("SELECT * FROM hosts WHERE id=?", (host_id,)).fetchone()
            if not host:
                raise ValueError(f"目标不存在：{host_id}")
            hosts.append(dict(host))
        if not hosts:
            raise ValueError("没有可执行的线，灰色禁用的线不会执行")
`
  );
  py = py.replace(
`            if path == "/api/plans":
                return self.save_plan(payload)
`,
`            if path == "/api/plans":
                return self.save_plan(payload)
            if path == "/api/plans/copy":
                return self.copy_plan(payload)
            if path == "/api/line-flags":
                return self.save_line_flag(payload)
`
  );
  py = py.replace(
`    def save_plan(self, payload):
`,
`    def copy_plan(self, payload):
        plan_id = int(payload.get("id") or 0)
        with connect() as conn:
            plan = conn.execute("SELECT * FROM plans WHERE id=?", (plan_id,)).fetchone()
            if not plan:
                raise ValueError("方案不存在")
            cur = conn.execute(
                "INSERT INTO plans (name, created_at) VALUES (?, ?)",
                (plan["name"] + " 副本", now()),
            )
            new_id = cur.lastrowid
            steps = conn.execute("SELECT * FROM steps WHERE plan_id=? ORDER BY position, id", (plan_id,)).fetchall()
            for step in steps:
                conn.execute(
                    """
                    INSERT INTO steps (plan_id, host_id, position, kind, command, local_path, remote_path)
                    VALUES (?, ?, ?, ?, ?, ?, ?)
                    """,
                    (new_id, step["host_id"], step["position"], step["kind"], step["command"], step["local_path"], step["remote_path"]),
                )
            flags = conn.execute("SELECT * FROM line_flags WHERE plan_id=?", (plan_id,)).fetchall()
            for flag in flags:
                conn.execute(
                    "INSERT INTO line_flags (plan_id, host_id, disabled) VALUES (?, ?, ?)",
                    (new_id, flag["host_id"], flag["disabled"]),
                )
        self.send_json({"id": new_id})

    def save_line_flag(self, payload):
        plan_id = int(payload.get("planId") or 0)
        host_id = int(payload.get("hostId") or 0)
        disabled = 1 if payload.get("disabled") else 0
        if not plan_id or not host_id:
            raise ValueError("请选择方案和目标线")
        with connect() as conn:
            conn.execute(
                """
                INSERT INTO line_flags (plan_id, host_id, disabled) VALUES (?, ?, ?)
                ON CONFLICT(plan_id, host_id) DO UPDATE SET disabled=excluded.disabled
                """,
                (plan_id, host_id, disabled),
            )
        self.send_json({"ok": True})

    def save_plan(self, payload):
`
  );
}
fs.writeFileSync(pyPath, py);

const htmlPath = "D:/tmp/deploy-system/public/index.html";
let html = fs.readFileSync(htmlPath, "utf8");
if (!html.includes("copy-plan")) {
  html = html.replace(
    '<button id="new-plan" class="ghost">新建方案</button>',
    '<button id="new-plan" class="ghost">新建方案</button>\n    <button id="copy-plan" class="ghost">复制画布</button>'
  );
  fs.writeFileSync(htmlPath, html);
}

const jsPath = "D:/tmp/deploy-system/public/app.js";
let js = fs.readFileSync(jsPath, "utf8");
js = js.replace(
`      actions: [
        { label: "刷新这条线", run: () => refreshLine(host) },
        { label: "执行这条线", run: () => runLine(host.id) },
        { label: "加命令", run: () => addStep("remote", host.id) },
        { label: "加上传", run: () => addStep("upload", host.id) },
        { label: "删除这条线", run: () => deleteLine(host) },
      ],
    };`,
`      actions: [
        { label: "刷新这条线", run: () => refreshLine(host) },
        { label: "执行这条线", run: () => runLine(host.id) },
        { label: "加命令", run: () => addStep("remote", host.id) },
        { label: "加上传", run: () => addStep("upload", host.id) },
        { label: disabled ? "启用这条线" : "禁用这条线", run: () => toggleLine(host, !disabled) },
        { label: "删除这条线", run: () => deleteLine(host) },
      ],
    };
    if (disabled) hostNode.tone = "disabled";`
);
if (!js.includes("const disabled =")) {
  js = js.replace(
    "for (const host of state.hosts) {\n    const hostNode = {",
    "for (const host of state.hosts) {\n    const disabled = !!(plan && (plan.disabledHostIds || []).some((id) => Number(id) === Number(host.id)));\n    const hostNode = {"
  );
}
js = js.replace(
`    const lineDone = hostSteps.length && hostSteps.every((step) => step.status === "success");
    if (failed) hostNode.tone = "failed";
    else if (running) hostNode.tone = "running";
    else if (lineDone) hostNode.tone = "success";
    if (failed || running || lineDone) hostNode.badge = failed ? "失败" : running ? "执行中" : "完成";`,
`    const lineDone = hostSteps.length && hostSteps.every((step) => step.status === "success");
    if (!disabled && failed) hostNode.tone = "failed";
    else if (!disabled && running) hostNode.tone = "running";
    else if (!disabled && lineDone) hostNode.tone = "success";
    if (disabled) hostNode.badge = "已禁用";
    else if (failed || running || lineDone) hostNode.badge = failed ? "失败" : running ? "执行中" : "完成";`
);
js = js.replace(
`        tone: step.status && step.status !== "pending" ? step.status : "",
        badge: step.status && step.status !== "pending" ? statusLabel[step.status] : "",`,
`        tone: disabled ? "disabled" : (step.status && step.status !== "pending" ? step.status : ""),
        badge: disabled ? "" : (step.status && step.status !== "pending" ? statusLabel[step.status] : ""),`
);
js = js.replace(
  'appendResult(nodes, edges, previous, "result-" + host.id, sourceSteps, hostSteps.length > 0, host.id);',
  'appendResult(nodes, edges, previous, "result-" + host.id, disabled ? [] : sourceSteps, !disabled && hostSteps.length > 0, host.id, disabled);'
);
js = js.replace(
  "function appendResult(nodes, edges, previous, id, steps, inThisRun, hostId) {",
  "function appendResult(nodes, edges, previous, id, steps, inThisRun, hostId, disabled) {"
);
js = js.replace(
`    tone: stateText.tone,
    badge: stateText.title === "未执行" ? "" : stateText.title,`,
`    tone: disabled ? "disabled" : stateText.tone,
    badge: disabled ? "已禁用" : (stateText.title === "未执行" ? "" : stateText.title),
    title: disabled ? "已禁用" : stateText.title,
    sub: disabled ? "这条线不会执行" : sub,`
);
if (!js.includes("async function toggleLine")) {
  js = js.replace(
    "document.querySelector(\"#new-plan\").onclick",
    `document.querySelector("#copy-plan").onclick = async () => {
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

async function toggleLine(host, disabled) {
  const plan = await ensurePlan();
  await api("/api/line-flags", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ planId: plan.id, hostId: host.id, disabled }),
  });
  await loadState();
}

document.querySelector("#new-plan").onclick`
  );
}
fs.writeFileSync(jsPath, js);
fs.appendFileSync("D:/tmp/deploy-system/public/style.css", `
.node.disabled {
  background: #eef1f4;
  border-color: #d9e0e8;
  color: #8b939e;
  box-shadow: none;
}
.node.disabled .title,
.node.disabled .sub,
.node.disabled .kicker,
.node.disabled .badge { color: #8b939e; }
`);
const root = "C:/Users/jiuzhou/Documents/Codex/2026-10-29/new-chat-3/deploy-system";
fs.copyFileSync(pyPath, root + "/app.py");
fs.copyFileSync(jsPath, root + "/public/app.js");
fs.copyFileSync(htmlPath, root + "/public/index.html");
fs.copyFileSync("D:/tmp/deploy-system/public/style.css", root + "/public/style.css");
console.log("done", py.includes("StrictHostKeyChecking=no"), js.includes("copy-plan"), html.includes("复制画布"));
