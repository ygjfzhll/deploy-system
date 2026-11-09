const fs = require("fs");
const p = "D:/tmp/deploy-system/app.py";
let c = fs.readFileSync(p, "utf8");
if (!c.includes("def skip_host_rest")) {
  c = c.replace(
`def skip_rest(run_id):
    with _lock, connect() as conn:
        conn.execute(
            """
            UPDATE run_steps
            SET status='skipped', finished_at=?
            WHERE run_id=? AND status='pending'
            """,
            (now(), run_id),
        )
`,
`def skip_rest(run_id):
    with _lock, connect() as conn:
        conn.execute(
            """
            UPDATE run_steps
            SET status='skipped', finished_at=?
            WHERE run_id=? AND status='pending'
            """,
            (now(), run_id),
        )


def skip_host_rest(run_id, host_id):
    with _lock, connect() as conn:
        conn.execute(
            """
            UPDATE run_steps
            SET status='skipped', finished_at=?
            WHERE run_id=? AND host_id=? AND status='pending'
            """,
            (now(), run_id, host_id),
        )
`
  );
}
c = c.replace(
`    failed = False
    message = "全部完成"
    shells = {}
    for item in items:
`,
`    failure_messages = []
    stopped_hosts = set()
    shells = {}
    for item in items:
        if item["host_id"] in stopped_hosts:
            continue
`
);
const stopHost = `stopped_hosts.add(item["host_id"])
            if item.get("host_id") is not None:
                close_shell(shells, item["host_id"])
                skip_host_rest(run_id, item["host_id"])
            failure_messages.append(message)
            continue`;
c = c.replace(
`            failed = True
            message = "目标或命令已不存在"
            break
`,
`            message = "目标或命令已不存在"
            ${stopHost}
`
);
c = c.replace(
`            failed = True
            message = str(exc)
            break
`,
`            message = str(exc)
            ${stopHost}
`
);
c = c.replace(
`            failed = True
            message = f"{item['host_label']} 执行失败，退出码 {code}"
            break
`,
`            message = f"{item['host_label']} 执行失败，退出码 {code}"
            ${stopHost}
`
);
c = c.replace(
`    if failed:
        skip_rest(run_id)
        finish_run(run_id, "failed", message)
    else:
        finish_run(run_id, "success", message)
`,
`    if failure_messages:
        finish_run(run_id, "failed", "；".join(failure_messages))
    else:
        finish_run(run_id, "success", "全部完成")
`
);
fs.writeFileSync(p, c);
fs.copyFileSync(p, "C:/Users/jiuzhou/Documents/Codex/2026-10-29/new-chat-3/deploy-system/app.py");
console.log("patched", c.includes("skip_host_rest"), c.includes("failure_messages"));
