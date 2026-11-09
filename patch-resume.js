const fs = require("fs");
const py = "D:/tmp/deploy-system/app.py";
const js = "D:/tmp/deploy-system/public/app.js";
let p = fs.readFileSync(py, "utf8");
if (!p.includes("from_step_id")) {
  p = p.replace(
    "def start_run(plan_id, host_ids):",
    "def start_run(plan_id, host_ids, from_step_id=None):"
  );
  p = p.replace(
    'run_id = start_run(int(payload["planId"]), [int(x) for x in payload["hostIds"]])',
    'run_id = start_run(int(payload["planId"]), [int(x) for x in payload["hostIds"]], int(payload["fromStepId"]) if payload.get("fromStepId") else None)'
  );
  const old = `            for step in steps:
                preview = step["command"] or f"{step['kind']} {step['local_path']} -> {step['remote_path']}"
                conn.execute(
                    """
                    INSERT INTO run_steps
                    (run_id, position, host_id, host_label, step_id, kind, preview, status)
                    VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')
                    """,
                    (
                        run_id,
                        position,
                        host["id"],
                        f"{host['name']} ({host['username']}@{host['ip']})",
                        step["id"],
                        step["kind"],
                        preview,
                    ),
                )
                position += 1`;
  const neu = `            resume_at = None
            if from_step_id:
                matched = [step for step in steps if step["id"] == from_step_id]
                if not matched:
                    raise ValueError("没有找到要继续的命令")
                resume_at = matched[0]["position"]
            for step in steps:
                preview = step["command"] or f"{step['kind']} {step['local_path']} -> {step['remote_path']}"
                status = "pending"
                output = ""
                exit_code = None
                started = None
                finished = None
                if resume_at and step["position"] < resume_at:
                    status = "success"
                    prev = conn.execute(
                        "SELECT output FROM run_steps WHERE step_id=? AND status='success' ORDER BY id DESC LIMIT 1",
                        (step["id"],),
                    ).fetchone()
                    output = ((prev["output"] if prev and prev["output"] else "") + "\\n已跳过，从失败命令继续\\n").strip() + "\\n"
                    exit_code = 0
                    started = now()
                    finished = now()
                conn.execute(
                    """
                    INSERT INTO run_steps
                    (run_id, position, host_id, host_label, step_id, kind, preview, status, output, exit_code, started_at, finished_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        run_id,
                        position,
                        host["id"],
                        f"{host['name']} ({host['username']}@{host['ip']})",
                        step["id"],
                        step["kind"],
                        preview,
                        status,
                        output,
                        exit_code,
                        started,
                        finished,
                    ),
                )
                position += 1`;
  if (!p.includes(old)) throw new Error("loop missing");
  p = p.replace(old, neu);
  fs.writeFileSync(py, p);
}
let j = fs.readFileSync(js, "utf8");
if (!j.includes("从这里继续")) {
  j = j.replace(
    '{ label: "查看命令", run: () => openViewer({ title: "完整命令", kicker: "查看", sub: "", badge: "", log: (ownSteps[index] || step).command || step.preview || step.command || "" }) },',
    `...(step.status === "failed" ? [{ label: "从这里继续", run: () => runLine(host.id, step.step_id || (ownSteps[index] && ownSteps[index].id)) }] : []),
          { label: "查看命令", run: () => openViewer({ title: "完整命令", kicker: "查看", sub: "", badge: "", log: (ownSteps[index] || step).command || step.preview || step.command || "" }) },`
  );
  j = j.replace(
    "async function runLine(hostId) {",
    `async function runLine(hostId, fromStepId) {
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

async function runLineUnused(hostId) {`
  );
  fs.writeFileSync(js, j);
}
fs.copyFileSync(py, "C:/Users/jiuzhou/Documents/Codex/2026-10-29/new-chat-3/deploy-system/app.py");
fs.copyFileSync(js, "C:/Users/jiuzhou/Documents/Codex/2026-10-29/new-chat-3/deploy-system/public/app.js");
console.log("ok");
