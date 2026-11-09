const fs = require("fs");
const p = "D:/tmp/deploy-system/app.py";
let c = fs.readFileSync(p, "utf8");
if (!c.includes("def assign_legacy_steps")) {
  c = c.replace(
    "def init_db():",
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


def init_db():`
  );
}
c = c.replace(
`            """
        )


def rows(`,
`            """
        )
        assign_legacy_steps(conn)


def rows(`
);
c = c.replace(
`            steps = rows(conn, "SELECT * FROM steps WHERE plan_id=? AND host_id=? ORDER BY position, id", (plan_id, host["id"]))`,
`            steps = [dict(row) for row in conn.execute("SELECT * FROM steps WHERE plan_id=? AND host_id=? ORDER BY position, id", (plan_id, host["id"]))]`
);
fs.writeFileSync(p, c);
console.log("mig", c.includes("def assign_legacy_steps"), c.includes("assign_legacy_steps(conn)"));
