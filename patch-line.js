const fs = require("fs");
const jsPath = "D:/tmp/deploy-system/public/app.js";
const pyPath = "D:/tmp/deploy-system/app.py";
let js = fs.readFileSync(jsPath, "utf8");
js = js.replace(
`      actions: [
        { label: "加命令", run: () => addStep("remote", host.id) },
        { label: "加上传", run: () => addStep("upload", host.id) },
      ],`,
`      actions: [
        { label: "执行这条线", run: () => runLine(host.id) },
        { label: "加命令", run: () => addStep("remote", host.id) },
        { label: "加上传", run: () => addStep("upload", host.id) },
        { label: "删除这条线", run: () => deleteLine(host) },
      ],`
);
if (!js.includes("async function runLine")) {
  js = js.replace(
`document.querySelector("#start-run").onclick = async () => {`,
`async function runLine(hostId) {
  try {
    const plan = await ensurePlan();
    const result = await api("/api/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ planId: Number(plan.id), hostIds: [Number(hostId)] }),
    });
    watchRun(result.id);
  } catch (error) {
    alert(error.message);
  }
}

async function deleteLine(host) {
  if (!confirm("删除 " + host.name + " 这条线？这台机器和它自己的命令都会去掉。")) return;
  await api("/api/hosts/" + host.id, { method: "DELETE" });
  document.querySelector("#panel").hidden = true;
  await loadState();
}

document.querySelector("#start-run").onclick = async () => {`
  );
}
fs.writeFileSync(jsPath, js);
let py = fs.readFileSync(pyPath, "utf8");
py = py.replace(
`            if len(parts) == 3 and parts[0] == "api" and parts[1] == "hosts":
                with connect() as conn:
                    conn.execute("DELETE FROM hosts WHERE id=?", (int(parts[2]),))
                return self.send_json({"ok": True})`,
`            if len(parts) == 3 and parts[0] == "api" and parts[1] == "hosts":
                host_id = int(parts[2])
                with connect() as conn:
                    conn.execute("DELETE FROM steps WHERE host_id=?", (host_id,))
                    conn.execute("DELETE FROM hosts WHERE id=?", (host_id,))
                return self.send_json({"ok": True})`
);
fs.writeFileSync(pyPath, py);
console.log("ok", js.includes("runLine"), py.includes("DELETE FROM steps WHERE host_id"));
