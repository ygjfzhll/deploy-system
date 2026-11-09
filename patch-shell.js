const fs = require("fs");
const p = "D:/tmp/deploy-system/app.py";
let c = fs.readFileSync(p, "utf8");
const start = c.indexOf("def execute_run(run_id):");
const end = c.indexOf("def start_run(plan_id, host_ids):");
if (start < 0 || end < 0) throw new Error("execute_run missing");
const fn = `def read_until(proc, item_id, marker):
    output_len = 0
    assert proc.stdout is not None
    while True:
        line = proc.stdout.readline()
        if line == "":
            return None, output_len
        if line.strip() == marker:
            return True, output_len
        output_len += len(line)
        if output_len <= 200_000:
            append_output(item_id, line)
        if _current["cancel"]:
            try:
                os.killpg(proc.pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
            return False, output_len


def ensure_shell(shells, host):
    proc = shells.get(host["id"])
    if proc and proc.poll() is None:
        return proc
    argv = ssh_base(host) + ["bash", "--noprofile", "--norc", "-s"]
    proc = subprocess.Popen(
        argv,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        stdin=subprocess.PIPE,
        text=True,
        bufsize=1,
        env=command_env(host),
        start_new_session=True,
    )
    proc.stdin.write("set +e\\nexport DEPLOY_PREV_OUTPUT=\\nexport DEPLOY_PREV_STATUS=0\\nprintf '%s\\\\n' __DEPLOY_READY__\\n")
    proc.stdin.flush()
    ready, _ = read_until(proc, 0, "__DEPLOY_READY__")
    if ready is not True or proc.poll() is not None:
        raise OSError("远程终端没有建立成功")
    shells[host["id"]] = proc
    shells[str(host["id"]) + ":n"] = 0
    return proc


def close_shell(shells, host_id):
    proc = shells.pop(host_id, None)
    shells.pop(str(host_id) + ":n", None)
    if not proc or proc.poll() is not None:
        return
    try:
        proc.stdin.write("exit\\n")
        proc.stdin.flush()
        proc.wait(timeout=5)
    except Exception:
        try:
            os.killpg(proc.pid, signal.SIGTERM)
        except ProcessLookupError:
            pass


def run_in_shell(proc, shells, host, item_id, command):
    count = int(shells.get(str(host["id"]) + ":n", 0)) + 1
    shells[str(host["id"]) + ":n"] = count
    token = f"DEPLOY_DONE_{item_id}_{count}"
    marker = f"__{token}__"
    script = f"""cat > /tmp/{token}.cmd <<'END_{token}'
{command}
END_{token}
source /tmp/{token}.cmd > /tmp/{token}.out 2>&1
export DEPLOY_PREV_STATUS=$?
export DEPLOY_PREV_OUTPUT="$(cat /tmp/{token}.out)"
export DEPLOY_OUTPUT_{count}="$DEPLOY_PREV_OUTPUT"
cat /tmp/{token}.out
printf '%s\\\\n' '{marker} '$DEPLOY_PREV_STATUS
"""
    proc.stdin.write(script)
    proc.stdin.flush()
    _current["proc"] = proc
    seen, _ = read_until(proc, item_id, marker)
    code = 1
    if seen is True:
        last = ""
        # marker line was consumed by read_until only when exact strip match.
        # Status is appended after the marker text in the same line, so match differently.
        code = 0
    return seen, code


def execute_run(run_id):
    with connect() as conn:
        items = rows(
            conn,
            "SELECT * FROM run_steps WHERE run_id=? AND status='pending' ORDER BY position, id",
            (run_id,),
        )
        hosts = {h["id"]: h for h in rows(conn, "SELECT * FROM hosts")}
        steps = {s["id"]: s for s in rows(conn, "SELECT * FROM steps")}
    failed = False
    message = "全部完成"
    shells = {}
    for item in items:
        if _current["cancel"]:
            for host_id in list(shells):
                if isinstance(host_id, int):
                    close_shell(shells, host_id)
            update_step(item["id"], status="skipped", finished_at=now(), output="已手动停止\\n")
            skip_rest(run_id)
            finish_run(run_id, "cancelled", "已手动停止")
            return
        host = hosts.get(item["host_id"])
        step = steps.get(item["step_id"])
        update_step(item["id"], status="running", started_at=now())
        if not host or not step:
            update_step(item["id"], status="failed", finished_at=now(), exit_code=1, output="目标或命令已不存在\\n")
            failed = True
            message = "目标或命令已不存在"
            break
        try:
            if step["kind"] == "remote":
                proc = ensure_shell(shells, host)
                code = run_remote(proc, shells, host, item["id"], step["command"])
                preview = step["command"].strip()
                update_step(item["id"], preview=preview)
            else:
                argv, preview = build_argv(host, step)
                update_step(item["id"], preview=preview)
                proc = subprocess.Popen(
                    argv,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.STDOUT,
                    stdin=subprocess.DEVNULL,
                    text=True,
                    bufsize=1,
                    env=command_env(host),
                    start_new_session=True,
                )
                _current["proc"] = proc
                output_len = 0
                assert proc.stdout is not None
                for line in proc.stdout:
                    output_len += len(line)
                    if output_len <= 200_000:
                        append_output(item["id"], line)
                    if _current["cancel"]:
                        try:
                            os.killpg(proc.pid, signal.SIGTERM)
                        except ProcessLookupError:
                            pass
                        break
                code = proc.wait()
                _current["proc"] = None
        except (ValueError, OSError) as exc:
            update_step(item["id"], status="failed", finished_at=now(), exit_code=1, output=str(exc) + "\\n")
            failed = True
            message = str(exc)
            break
        if _current["cancel"]:
            for host_id in list(shells):
                if isinstance(host_id, int):
                    close_shell(shells, host_id)
            update_step(item["id"], status="failed", finished_at=now(), exit_code=code if isinstance(code, int) else 1)
            append_output(item["id"], "\\n已手动停止\\n")
            skip_rest(run_id)
            finish_run(run_id, "cancelled", "已手动停止")
            return
        if code != 0:
            update_step(item["id"], status="failed", finished_at=now(), exit_code=code)
            append_output(item["id"], f"\\n退出码 {code}，已停止后续步骤\\n")
            failed = True
            message = f"{item['host_label']} 执行失败，退出码 {code}"
            break
        update_step(item["id"], status="success", finished_at=now(), exit_code=0)
    for host_id in list(shells):
        if isinstance(host_id, int):
            close_shell(shells, host_id)
    if failed:
        skip_rest(run_id)
        finish_run(run_id, "failed", message)
    else:
        finish_run(run_id, "success", message)
    _current["run_id"] = None
    _current["cancel"] = False


def run_remote(proc, shells, host, item_id, command):
    count = int(shells.get(str(host["id"]) + ":n", 0)) + 1
    shells[str(host["id"]) + ":n"] = count
    token = f"DEPLOY_DONE_{item_id}_{count}"
    marker = f"__{token}__"
    script = (
        f"cat > /tmp/{token}.cmd <<'END_{token}'\\n"
        f"{command}\\n"
        f"END_{token}\\n"
        f"source /tmp/{token}.cmd > /tmp/{token}.out 2>&1\\n"
        f"export DEPLOY_PREV_STATUS=$?\\n"
        f"export DEPLOY_PREV_OUTPUT=\\"$(cat /tmp/{token}.out)\\"\\n"
        f"export DEPLOY_OUTPUT_{count}=\\"$DEPLOY_PREV_OUTPUT\\"\\n"
        f"cat /tmp/{token}.out\\n"
        f"printf '%s\\\\n' \\"{marker} $DEPLOY_PREV_STATUS\\"\\n"
    )
    proc.stdin.write(script)
    proc.stdin.flush()
    _current["proc"] = proc
    output_len = 0
    assert proc.stdout is not None
    while True:
        line = proc.stdout.readline()
        if line == "":
            _current["proc"] = None
            return 1
        stripped = line.strip()
        if stripped.startswith(marker + " "):
            _current["proc"] = None
            try:
                return int(stripped.rsplit(" ", 1)[-1])
            except ValueError:
                return 1
        output_len += len(line)
        if output_len <= 200_000:
            append_output(item_id, line)
        if _current["cancel"]:
            try:
                os.killpg(proc.pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
            _current["proc"] = None
            return 1


`;
c = c.slice(0, start) + fn + c.slice(end);
fs.writeFileSync(p, c);
console.log("replaced", c.includes("def run_remote"));
