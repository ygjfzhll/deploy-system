const fs = require("fs");
const py = "D:/tmp/deploy-system/app.py";
const js = "D:/tmp/deploy-system/public/app.js";
let p = fs.readFileSync(py, "utf8");
if (!p.includes('"/api/lines/copy"')) {
  p = p.replace(
    'if path == "/api/line-flags":\n                return self.save_line_flag(payload)\n',
    'if path == "/api/line-flags":\n                return self.save_line_flag(payload)\n            if path == "/api/lines/copy":\n                return self.copy_line(payload)\n'
  );
  p = p.replace(
    "    def save_line_flag(self, payload):",
    `    def copy_line(self, payload):
        plan_id = int(payload.get("planId") or 0)
        host_id = int(payload.get("hostId") or 0)
        with connect() as conn:
            host = conn.execute("SELECT * FROM hosts WHERE id=?", (host_id,)).fetchone()
            if not host:
                raise ValueError("目标不存在")
            cur = conn.execute(
                """
                INSERT INTO hosts (name, ip, port, username, identity_file, password, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?)
                """,
                (host["name"] + " 副本", host["ip"], host["port"], host["username"], host["identity_file"], host["password"], now()),
            )
            new_host_id = cur.lastrowid
            steps = conn.execute(
                "SELECT * FROM steps WHERE plan_id=? AND host_id=? ORDER BY position, id",
                (plan_id, host_id),
            ).fetchall()
            for index, step in enumerate(steps, start=1):
                conn.execute(
                    """
                    INSERT INTO steps (plan_id, host_id, position, kind, command, local_path, remote_path)
                    VALUES (?, ?, ?, ?, ?, ?, ?)
                    """,
                    (plan_id, new_host_id, index, step["kind"], step["command"], step["local_path"], step["remote_path"]),
                )
            flag = conn.execute(
                "SELECT disabled FROM line_flags WHERE plan_id=? AND host_id=?",
                (plan_id, host_id),
            ).fetchone()
            if flag:
                conn.execute(
                    "INSERT INTO line_flags (plan_id, host_id, disabled) VALUES (?, ?, ?)",
                    (plan_id, new_host_id, flag["disabled"]),
                )
        self.send_json({"id": new_host_id})

    def save_line_flag(self, payload):`
  );
  fs.writeFileSync(py, p);
}
let j = fs.readFileSync(js, "utf8");
if (!j.includes("复制这条线")) {
  j = j.replace(
    '{ label: disabled ? "启用这条线" : "禁用这条线", run: () => toggleLine(host, !disabled) },',
    '{ label: "复制这条线", run: () => copyLine(host) },\n        { label: disabled ? "启用这条线" : "禁用这条线", run: () => toggleLine(host, !disabled) },'
  );
  j = j.replace(
    "async function toggleLine(host, disabled) {",
    `async function copyLine(host) {
  const plan = await ensurePlan();
  await api("/api/lines/copy", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ planId: plan.id, hostId: host.id }),
  });
  await loadState();
}

async function toggleLine(host, disabled) {`
  );
  fs.writeFileSync(js, j);
}
const root = "C:/Users/jiuzhou/Documents/Codex/2026-10-29/new-chat-3/deploy-system";
fs.copyFileSync(py, root + "/app.py");
fs.copyFileSync(js, root + "/public/app.js");
console.log("ok");
