const fs = require("fs");
const pyPath = "D:/tmp/deploy-system/app.py";
const jsPath = "D:/tmp/deploy-system/public/app.js";
let py = fs.readFileSync(pyPath, "utf8");
if (!py.includes('ADD COLUMN note')) {
  py = py.replace(
    "def assign_legacy_steps(conn):\n",
    `def assign_legacy_steps(conn):
    columns = [row[1] for row in conn.execute("PRAGMA table_info(steps)")]
    if "note" not in columns:
        conn.execute("ALTER TABLE steps ADD COLUMN note TEXT NOT NULL DEFAULT ''")
`
  );
}
py = py.replace(
  "SET kind=?, command=?, local_path=?, remote_path=?, host_id=?",
  "SET kind=?, command=?, local_path=?, remote_path=?, host_id=?, note=?"
);
py = py.replace(
  "(kind, command, local_path, remote_path, host_id, int(payload[\"id\"]), plan_id),",
  "(kind, command, local_path, remote_path, host_id, str(payload.get(\"note\") or \"\"), int(payload[\"id\"]), plan_id),"
);
py = py.replaceAll(
  "INSERT INTO steps (plan_id, host_id, position, kind, command, local_path, remote_path)\n                VALUES (?, ?, ?, ?, ?, ?, ?)",
  "INSERT INTO steps (plan_id, host_id, position, kind, command, local_path, remote_path, note)\n                VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
);
py = py.replaceAll(
  "INSERT INTO steps (plan_id, host_id, position, kind, command, local_path, remote_path)\n                    VALUES (?, ?, ?, ?, ?, ?, ?)",
  "INSERT INTO steps (plan_id, host_id, position, kind, command, local_path, remote_path, note)\n                    VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
);
const notePairs = [
  ['(step["plan_id"], host["id"], step["position"], step["kind"], step["command"], step["local_path"], step["remote_path"]),',
   '(step["plan_id"], host["id"], step["position"], step["kind"], step["command"], step["local_path"], step["remote_path"], step["note"] if "note" in step.keys() else ""),'],
  ['(plan_id, host_id, position, kind, command, local_path, remote_path),',
   '(plan_id, host_id, position, kind, command, local_path, remote_path, str(payload.get("note") or "")),'],
  ['(new_id, step["host_id"], step["position"], step["kind"], step["command"], step["local_path"], step["remote_path"]),',
   '(new_id, step["host_id"], step["position"], step["kind"], step["command"], step["local_path"], step["remote_path"], step["note"]),'],
  ['(plan_id, new_host_id, index, step["kind"], step["command"], step["local_path"], step["remote_path"]),',
   '(plan_id, new_host_id, index, step["kind"], step["command"], step["local_path"], step["remote_path"], step["note"]),'],
  ['(plan_id, host_id, index, kind, str(step.get("command") or ""), str(step.get("localPath") or ""), str(step.get("remotePath") or "")),',
   '(plan_id, host_id, index, kind, str(step.get("command") or ""), str(step.get("localPath") or ""), str(step.get("remotePath") or ""), str(step.get("note") or "")),'],
];
for (const [a, b] of notePairs) {
  if (!py.includes(a)) throw new Error("tuple missing: " + a.slice(0, 60));
  py = py.replace(a, b);
}
fs.writeFileSync(pyPath, py);

let js = fs.readFileSync(jsPath, "utf8");
if (!js.includes("function stepCaption")) {
  js = js.replace(
    "const kindLabel = { remote: \"远程命令\", upload: \"上传\", download: \"下载\", local: \"本机命令\" };",
    `const kindLabel = { remote: "远程命令", upload: "上传", download: "下载", local: "本机命令" };

function stepCaption(step, planStep) {
  const note = (planStep && planStep.note) || step.note || "";
  return note.trim() || kindLabel[step.kind] || "命令";
}`
  );
}
js = js.replace(
  'kicker: (step.position || index + 1) + " · " + (kindLabel[step.kind] || "命令"),',
  'kicker: (step.position || index + 1) + " · " + stepCaption(step, ownSteps.find((item) => item.id === (step.step_id || step.id)) || ownSteps[index]),'
);
js = js.replace(
  'kicker: (index + 1) + " · " + kindLabel[step.kind],',
  'kicker: (index + 1) + " · " + stepCaption(step),'
);
js = js.replace(
`  const fields = current.kind === "remote"
    ? [{ label: "这条线在目标机器上执行的命令", name: "command", type: "textarea", value: current.command }]
    : [
        { label: "本机路径", name: "localPath", value: current.local_path },
        { label: "目标路径", name: "remotePath", value: current.remote_path },
      ];`,
`  const fields = [
    { label: "说明，会替换节点上的「" + (kindLabel[current.kind] || "命令") + "」", name: "note", value: current.note || "" },
  ].concat(current.kind === "remote"
    ? [{ label: "这条线在目标机器上执行的命令", name: "command", type: "textarea", value: current.command }]
    : [
        { label: "本机路径", name: "localPath", value: current.local_path },
        { label: "目标路径", name: "remotePath", value: current.remote_path },
      ]);`
);
js = js.replace(
`        command: values.command || "",
        localPath: values.localPath || "",
        remotePath: values.remotePath || "",`,
`        command: values.command || "",
        localPath: values.localPath || "",
        remotePath: values.remotePath || "",
        note: values.note || "",`
);
fs.writeFileSync(jsPath, js);
const root = "C:/Users/jiuzhou/Documents/Codex/2026-10-29/new-chat-3/deploy-system";
fs.copyFileSync(pyPath, root + "/app.py");
fs.copyFileSync(jsPath, root + "/public/app.js");
console.log("ok");
