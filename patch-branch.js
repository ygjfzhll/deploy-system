const fs = require("fs");
const p = "D:/tmp/deploy-system/app.py";
let c = fs.readFileSync(p, "utf8");
if (!c.includes("def assign_legacy_steps")) {
  c = c.replace(
    "def init_db():\n    DATA.mkdir(exist_ok=True)\n    with connect() as conn:\n        conn.executescript(",
    `def assign_legacy_steps(conn):
    columns = [row[1] for row in conn.execute("PRAGMA table_info(steps)")]
    if "host_id" not in columns:
        conn.execute("ALTER TABLE steps ADD COLUMN host_id INTEGER")
    legacy = [dict(row) for row in conn.execute("SELECT * FROM steps WHERE host_id IS NULL ORDER BY position, id")]
    hosts = [dict(row) for row in conn.execute("SELECT id FROM hosts ORDER BY id")]
    if not legacy or not hosts:
        return
    for host in hosts:
        count = conn.execute("SELECT COUNT(*) AS n FROM steps WHERE host_id=?", (host["id"],)).fetchone()["n"]
        if count:
            continue
        for step in legacy:
            conn.execute(
                """
                INSERT INTO steps (plan_id, host_id, position, kind, command, local_path, remote_path)
                VALUES (?, ?, ?, ?, ?, ?, ?)
                """,
                (step["plan_id"], host["id"], step["position"], step["kind"], step["command"], step["local_path"], step["remote_path"]),
            )
    conn.execute("DELETE FROM steps WHERE host_id IS NULL")


def init_db():
    DATA.mkdir(exist_ok=True)
    with connect() as conn:
        conn.executescript(`
  );
  c = c.replace(
    "            )\n\n\ndef rows(",
    "            )\n        assign_legacy_steps(conn)\n\n\ndef rows("
  );
}
c = c.replace(
`        steps = rows(conn, "SELECT * FROM steps WHERE plan_id=? ORDER BY position, id", (plan_id,))
        if not steps:
            raise ValueError("命令方案里还没有步骤")
        hosts = []
        for host_id in host_ids:
            host = conn.execute("SELECT * FROM hosts WHERE id=?", (host_id,)).fetchone()
            if not host:
                raise ValueError(f"目标不存在：{host_id}")
            hosts.append(dict(host))
        if not hosts:
            raise ValueError("请至少选择一台目标机器")
`,
`        hosts = []
        for host_id in host_ids:
            host = conn.execute("SELECT * FROM hosts WHERE id=?", (host_id,)).fetchone()
            if not host:
                raise ValueError(f"目标不存在：{host_id}")
            hosts.append(dict(host))
        if not hosts:
            raise ValueError("请至少选择一台目标机器")
`
);
c = c.replace(
`        for host in hosts:
            for step in steps:
`,
`        for host in hosts:
            steps = rows(conn, "SELECT * FROM steps WHERE plan_id=? AND host_id=? ORDER BY position, id", (plan_id, host["id"]))
            if not steps:
                raise ValueError(host["name"] + " 这条线还没有自己的命令")
            for step in steps:
`
);
if (!c.includes('if path == "/api/steps"')) {
  c = c.replace(
    'if path == "/api/plans":\n                return self.save_plan(payload)\n',
    'if path == "/api/plans":\n                return self.save_plan(payload)\n            if path == "/api/steps":\n                return self.save_step(payload)\n'
  );
}
const oldSave = `    def save_plan(self, payload):
        name = payload.get("name", "").strip()
        steps = payload.get("steps") or []
        if not name:
            raise ValueError("方案名称不能为空")
        if not steps:
            raise ValueError("至少添加一条命令")
`;
const newSave = `    def save_step(self, payload):
        plan_id = int(payload.get("planId") or 0)
        host_id = int(payload.get("hostId") or 0)
        kind = payload.get("kind")
        if kind not in ("remote", "upload", "download", "local"):
            raise ValueError("步骤类型不正确")
        if not plan_id or not host_id:
            raise ValueError("请选择方案和对应的目标线")
        command = str(payload.get("command") or "")
        local_path = str(payload.get("localPath") or "")
        remote_path = str(payload.get("remotePath") or "")
        with connect() as conn:
            if payload.get("id"):
                conn.execute(
                    """
                    UPDATE steps
                    SET kind=?, command=?, local_path=?, remote_path=?, host_id=?
                    WHERE id=? AND plan_id=?
                    """,
                    (kind, command, local_path, remote_path, host_id, int(payload["id"]), plan_id),
                )
                step_id = int(payload["id"])
            else:
                position = conn.execute(
                    "SELECT COALESCE(MAX(position), 0) + 1 AS n FROM steps WHERE plan_id=? AND host_id=?",
                    (plan_id, host_id),
                ).fetchone()["n"]
                cur = conn.execute(
                    """
                    INSERT INTO steps (plan_id, host_id, position, kind, command, local_path, remote_path)
                    VALUES (?, ?, ?, ?, ?, ?, ?)
                    """,
                    (plan_id, host_id, position, kind, command, local_path, remote_path),
                )
                step_id = cur.lastrowid
        self.send_json({"id": step_id})

    def save_plan(self, payload):
        name = payload.get("name", "").strip()
        steps = payload.get("steps")
        if not name:
            raise ValueError("方案名称不能为空")
`;
if (!c.includes(oldSave)) throw new Error("save_plan header missing");
c = c.replace(oldSave, newSave);
c = c.replace(
`        with connect() as conn:
            if payload.get("id"):
                plan_id = int(payload["id"])
                conn.execute("UPDATE plans SET name=? WHERE id=?", (name, plan_id))
                conn.execute("DELETE FROM steps WHERE plan_id=?", (plan_id,))
            else:
                cur = conn.execute(
                    "INSERT INTO plans (name, created_at) VALUES (?, ?)",
                    (name, now()),
                )
                plan_id = cur.lastrowid
            for position, item in enumerate(cleaned, start=1):
                conn.execute(
                    """
                    INSERT INTO steps (plan_id, position, kind, command, local_path, remote_path)
                    VALUES (?, ?, ?, ?, ?, ?)
                    """,
                    (plan_id, position, *item),
                )
        self.send_json({"id": plan_id})
`,
`        with connect() as conn:
            if payload.get("id"):
                plan_id = int(payload["id"])
                conn.execute("UPDATE plans SET name=? WHERE id=?", (name, plan_id))
                if steps is not None:
                    conn.execute("DELETE FROM steps WHERE plan_id=?", (plan_id,))
            else:
                cur = conn.execute(
                    "INSERT INTO plans (name, created_at) VALUES (?, ?)",
                    (name, now()),
                )
                plan_id = cur.lastrowid
            if steps is not None:
                for index, step in enumerate(steps, start=1):
                    kind = step.get("kind")
                    host_id = int(step.get("hostId") or 0)
                    if kind not in ("remote", "upload", "download", "local") or not host_id:
                        raise ValueError("每条命令都要属于一台目标机器")
                    conn.execute(
                        """
                        INSERT INTO steps (plan_id, host_id, position, kind, command, local_path, remote_path)
                        VALUES (?, ?, ?, ?, ?, ?, ?)
                        """,
                        (plan_id, host_id, index, kind, str(step.get("command") or ""), str(step.get("localPath") or ""), str(step.get("remotePath") or "")),
                    )
        self.send_json({"id": plan_id})
`
);
c = c.replace(
`            if len(parts) == 3 and parts[0] == "api" and parts[1] == "plans":
                plan_id = int(parts[2])
                with connect() as conn:
                    conn.execute("DELETE FROM steps WHERE plan_id=?", (plan_id,))
                    conn.execute("DELETE FROM plans WHERE id=?", (plan_id,))
                return self.send_json({"ok": True})
`,
`            if len(parts) == 3 and parts[0] == "api" and parts[1] == "plans":
                plan_id = int(parts[2])
                with connect() as conn:
                    conn.execute("DELETE FROM steps WHERE plan_id=?", (plan_id,))
                    conn.execute("DELETE FROM plans WHERE id=?", (plan_id,))
                return self.send_json({"ok": True})
            if len(parts) == 3 and parts[0] == "api" and parts[1] == "steps":
                with connect() as conn:
                    conn.execute("DELETE FROM steps WHERE id=?", (int(parts[2]),))
                return self.send_json({"ok": True})
`
);
if (c.includes("cleaned.append")) {
  c = c.replace(/        cleaned = \[\]\n        for index, step in enumerate\(steps, start=1\):[\s\S]*?cleaned.append\(\n                \(\n                    kind,\n                    str\(step.get\("command"\) or ""\),\n                    str\(step.get\("localPath"\) or ""\),\n                    str\(step.get\("remotePath"\) or ""\),\n                \)\n            \)\n/, "");
}
fs.writeFileSync(p, c);
console.log("py", c.includes("def save_step"), c.includes("host_id=?"));
