#!/usr/bin/env python3
"""Linux 部署分发控制台：配置目标后，用系统 ssh/scp 顺序执行，并记录状态。"""

import argparse
import hashlib
import json
import os
import secrets
import shlex
import select
import signal
import sqlite3
import subprocess
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

ROOT = Path(__file__).resolve().parent
DATA = ROOT / "data"
DB_PATH = DATA / "app.sqlite"
PUBLIC = ROOT / "public"

_lock = threading.Lock()
_ai_undo = {}
_current = {"run_id": None, "proc": None, "procs": [], "cancel": False}


def remember_proc(proc):
    with _lock:
        if proc not in _current["procs"]:
            _current["procs"].append(proc)
        _current["proc"] = proc


def forget_proc(proc):
    with _lock:
        if proc in _current["procs"]:
            _current["procs"].remove(proc)
        if _current.get("proc") is proc:
            _current["proc"] = None


def now():
    return time.strftime("%Y-%m-%d %H:%M:%S")


def load_app_config():
    import json
    import re
    path = DATA / "app.json"
    if not path.is_file():
        return {}
    text = path.read_text(encoding="utf-8")
    text = re.sub(r"(^|\s)//.*?$", "", text, flags=re.M)
    return json.loads(text)


def app_setting(name, default, minimum=1):
    try:
        value = int(load_app_config().get(name) or default)
    except (OSError, ValueError, TypeError, json.JSONDecodeError):
        return default
    return max(minimum, value)


def max_parallel_lines():
    return app_setting("max_parallel_lines", 6)


def save_max_parallel_lines(value):
    import re
    value = max(1, int(value))
    path = DATA / "app.json"
    text = path.read_text(encoding="utf-8")
    updated, count = re.subn(r'("max_parallel_lines"\s*:\s*)\d+', r"\g<1>" + str(value), text, count=1)
    if count != 1:
        raise ValueError("配置文件里没有并发数")
    path.write_text(updated, encoding="utf-8")
    return value




def load_mysql_config():
    import json
    config_path = DATA / "mysql.json"
    if not config_path.is_file():
        raise RuntimeError("缺少 data/mysql.json")
    return json.loads(config_path.read_text(encoding="utf-8"))


class MySQLConn:
    def __init__(self, raw):
        self.raw = raw
        self.cur = raw.cursor()

    def execute(self, sql, args=()):
        self.cur.execute(sql.replace("?", "%s"), args or ())
        return self

    def executescript(self, script):
        for statement in script.split(";"):
            if statement.strip():
                self.execute(statement)
        return self

    def fetchone(self):
        return self.cur.fetchone()

    def fetchall(self):
        return self.cur.fetchall()

    @property
    def lastrowid(self):
        return self.cur.lastrowid

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, tb):
        try:
            if exc_type:
                self.raw.rollback()
            else:
                self.raw.commit()
        finally:
            self.raw.close()
        return False


def connect():
    import sys
    vendor = ROOT / "vendor"
    if vendor.exists():
        sys.path.insert(0, str(vendor))
    import pymysql
    from pymysql.cursors import DictCursor
    cfg = load_mysql_config()
    raw = pymysql.connect(
        host=cfg["host"],
        port=int(cfg.get("port") or 3306),
        user=cfg["user"],
        password=cfg["password"],
        database=cfg["database"],
        charset="utf8mb4",
        autocommit=False,
        cursorclass=DictCursor,
    )
    return MySQLConn(raw)


def assign_legacy_steps(conn):
    legacy = [dict(row) for row in conn.execute("SELECT * FROM steps WHERE host_id IS NULL ORDER BY position, id").fetchall()]
    hosts = [dict(row) for row in conn.execute("SELECT id FROM hosts ORDER BY id").fetchall()]
    if not legacy or not hosts:
        return
    for host in hosts:
        count = conn.execute("SELECT COUNT(*) AS n FROM steps WHERE host_id=?", (host["id"],)).fetchone()["n"]
        if count:
            continue
        for step in legacy:
            conn.execute(
                """
                INSERT INTO steps (plan_id, host_id, position, kind, command, local_path, remote_path, note)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (step["plan_id"], host["id"], step["position"], step["kind"], step["command"], step["local_path"], step["remote_path"], step.get("note") or ""),
            )
    conn.execute("DELETE FROM steps WHERE host_id IS NULL")


def init_db():
    DATA.mkdir(exist_ok=True)
    with connect() as conn:
        conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS hosts (
              id BIGINT PRIMARY KEY AUTO_INCREMENT,
              name VARCHAR(255) NOT NULL,
              ip VARCHAR(255) NOT NULL,
              port INT NOT NULL DEFAULT 22,
              username VARCHAR(255) NOT NULL,
              identity_file VARCHAR(1024) NOT NULL DEFAULT '',
              password VARCHAR(1024) NOT NULL DEFAULT '',
              created_at VARCHAR(32) NOT NULL
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
            CREATE TABLE IF NOT EXISTS plans (
              id BIGINT PRIMARY KEY AUTO_INCREMENT,
              name VARCHAR(255) NOT NULL,
              created_at VARCHAR(32) NOT NULL
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
            CREATE TABLE IF NOT EXISTS steps (
              id BIGINT PRIMARY KEY AUTO_INCREMENT,
              plan_id BIGINT NOT NULL,
              host_id BIGINT NULL,
              position INT NOT NULL,
              kind VARCHAR(32) NOT NULL,
              command MEDIUMTEXT NOT NULL,
              local_path VARCHAR(1024) NOT NULL DEFAULT '',
              remote_path VARCHAR(1024) NOT NULL DEFAULT '',
              note VARCHAR(255) NOT NULL DEFAULT ''
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
            CREATE TABLE IF NOT EXISTS runs (
              id BIGINT PRIMARY KEY AUTO_INCREMENT,
              plan_id BIGINT NULL,
              plan_name VARCHAR(255) NOT NULL,
              status VARCHAR(32) NOT NULL,
              message TEXT NOT NULL,
              created_at VARCHAR(32) NOT NULL,
              finished_at VARCHAR(32) NULL
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
            CREATE TABLE IF NOT EXISTS run_steps (
              id BIGINT PRIMARY KEY AUTO_INCREMENT,
              run_id BIGINT NOT NULL,
              position INT NOT NULL,
              host_id BIGINT NULL,
              host_label VARCHAR(255) NOT NULL,
              step_id BIGINT NULL,
              kind VARCHAR(32) NOT NULL,
              preview MEDIUMTEXT NOT NULL,
              status VARCHAR(32) NOT NULL,
              output MEDIUMTEXT NOT NULL,
              exit_code INT NULL,
              started_at VARCHAR(32) NULL,
              finished_at VARCHAR(32) NULL
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
            CREATE TABLE IF NOT EXISTS line_flags (
              plan_id BIGINT NOT NULL,
              host_id BIGINT NOT NULL,
              disabled TINYINT NOT NULL DEFAULT 0,
              PRIMARY KEY (plan_id, host_id)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
            """
        )
        assign_legacy_steps(conn)
        migrate_sqlite_if_needed(conn)
        has_force = conn.execute(
            "SELECT COUNT(*) AS n FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='line_flags' AND COLUMN_NAME='force_run'"
        ).fetchone()["n"]
        if not has_force:
            conn.execute("ALTER TABLE line_flags ADD COLUMN force_run TINYINT NOT NULL DEFAULT 0")
        conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS users (
              id BIGINT PRIMARY KEY AUTO_INCREMENT,
              username VARCHAR(64) NOT NULL,
              password_hash VARCHAR(255) NOT NULL,
              created_at VARCHAR(32) NOT NULL,
              is_admin TINYINT NOT NULL DEFAULT 0,
              UNIQUE KEY uniq_username (username)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
            CREATE TABLE IF NOT EXISTS sessions (
              token VARCHAR(64) PRIMARY KEY,
              user_id BIGINT NOT NULL,
              created_at VARCHAR(32) NOT NULL,
              expires_at VARCHAR(32) NOT NULL
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
            CREATE TABLE IF NOT EXISTS plan_access (
              user_id BIGINT NOT NULL,
              plan_id BIGINT NOT NULL,
              PRIMARY KEY (user_id, plan_id)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
            CREATE TABLE IF NOT EXISTS plan_hosts (
              plan_id BIGINT NOT NULL,
              host_id BIGINT NOT NULL,
              PRIMARY KEY (plan_id, host_id)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
            """
        )
        if not column_exists(conn, "users", "is_admin"):
            conn.execute("ALTER TABLE users ADD COLUMN is_admin TINYINT NOT NULL DEFAULT 0")
        if not column_exists(conn, "plans", "owner_id"):
            conn.execute("ALTER TABLE plans ADD COLUMN owner_id BIGINT NULL")
        if not column_exists(conn, "steps", "disabled"):
            conn.execute("ALTER TABLE steps ADD COLUMN disabled TINYINT NOT NULL DEFAULT 0")
        if conn.execute("SELECT COUNT(*) AS n FROM plan_hosts").fetchone()["n"] == 0:
            conn.execute("INSERT INTO plan_hosts (plan_id, host_id) SELECT plans.id, hosts.id FROM plans JOIN hosts")
        ensure_admin(conn)
        if not conn.execute("SELECT id FROM users WHERE is_admin=1 LIMIT 1").fetchone():
            conn.execute("UPDATE users SET is_admin=1 ORDER BY id LIMIT 1")


def migrate_sqlite_if_needed(conn):
    import sqlite3
    if not DB_PATH.is_file():
        return
    if conn.execute("SELECT COUNT(*) AS n FROM hosts").fetchone()["n"]:
        return
    src = sqlite3.connect(DB_PATH)
    src.row_factory = sqlite3.Row
    tables = [
        ("hosts", "id, name, ip, port, username, identity_file, password, created_at"),
        ("plans", "id, name, created_at"),
        ("steps", "id, plan_id, host_id, position, kind, command, local_path, remote_path, note"),
        ("runs", "id, plan_id, plan_name, status, message, created_at, finished_at"),
        ("run_steps", "id, run_id, position, host_id, host_label, step_id, kind, preview, status, output, exit_code, started_at, finished_at"),
        ("line_flags", "plan_id, host_id, disabled"),
    ]
    for table, columns in tables:
        names = [name.strip() for name in columns.split(",")]
        placeholders = ", ".join(["?"] * len(names))
        try:
            records = src.execute(f"SELECT {columns} FROM {table}").fetchall()
        except sqlite3.OperationalError:
            continue
        for record in records:
            conn.execute(
                f"INSERT INTO {table} ({columns}) VALUES ({placeholders})",
                tuple(record[name] if record[name] is not None else ("" if name in ("message", "output", "note", "command", "preview") else None) for name in names),
            )
        if "id" in names and records:
            max_id = max(record["id"] for record in records)
            conn.execute(f"ALTER TABLE {table} AUTO_INCREMENT = {int(max_id) + 1}")
    src.close()


def rows(conn, sql, args=()):
    return [dict(r) for r in conn.execute(sql, args).fetchall()]


def column_exists(conn, table, column):
    return conn.execute(
        "SELECT COUNT(*) AS n FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? AND COLUMN_NAME=?",
        (table, column),
    ).fetchone()["n"]


def hash_password(password, salt=None, rounds=120000):
    if salt is None:
        salt = secrets.token_hex(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt.encode("utf-8"), rounds).hex()
    return f"pbkdf2_sha256${rounds}${salt}${digest}"


def verify_password(password, stored):
    try:
        algo, rounds, salt, digest = stored.split("$", 3)
        if algo != "pbkdf2_sha256":
            return False
        return secrets.compare_digest(hash_password(password, salt, int(rounds)), stored)
    except (ValueError, TypeError):
        return False


def ensure_admin(conn):
    if conn.execute("SELECT COUNT(*) AS n FROM users").fetchone()["n"]:
        return
    conn.execute(
        "INSERT INTO users (username, password_hash, created_at, is_admin) VALUES (?, ?, ?, 1)",
        ("admin", hash_password("admin"), now()),
    )
    print("已创建初始账号 admin，初始密码 admin。登录后请立即修改密码。")


def can_plan(conn, user, plan_id):
    if not user or not plan_id:
        return False
    if user.get("is_admin"):
        return True
    return conn.execute(
        "SELECT plan_id FROM plan_access WHERE user_id=? AND plan_id=?",
        (user["id"], int(plan_id)),
    ).fetchone() is not None


def grant_plan(conn, user_id, plan_id):
    conn.execute(
        "INSERT IGNORE INTO plan_access (user_id, plan_id) VALUES (?, ?)",
        (int(user_id), int(plan_id)),
    )


def can_plan_for(user, plan_id):
    with connect() as conn:
        return can_plan(conn, user, plan_id)


def public_state(user):
    with connect() as conn:
        hosts = rows(conn, "SELECT * FROM hosts ORDER BY id")
        for host in hosts:
            host["has_password"] = bool(host.get("password"))
            host.pop("password", None)
        plans = rows(conn, "SELECT * FROM plans ORDER BY id DESC")
        if not user.get("is_admin"):
            allowed = {row["plan_id"] for row in rows(conn, "SELECT plan_id FROM plan_access WHERE user_id=?", (user["id"],))}
            plans = [plan for plan in plans if plan["id"] in allowed]
        allowed_ids = {plan["id"] for plan in plans}
        flags = rows(conn, "SELECT plan_id, host_id FROM line_flags WHERE disabled=1")
        for plan in plans:
            plan["steps"] = rows(
                conn,
                "SELECT * FROM steps WHERE plan_id=? ORDER BY position, id",
                (plan["id"],),
            )
            plan["disabledHostIds"] = [row["host_id"] for row in flags if row["plan_id"] == plan["id"]]
            plan["hostIds"] = [row["host_id"] for row in rows(conn, "SELECT host_id FROM plan_hosts WHERE plan_id=? ORDER BY host_id", (plan["id"],))]
        runs = [run for run in rows(conn, "SELECT * FROM runs ORDER BY id DESC LIMIT 30") if run["plan_id"] in allowed_ids]
    busy = _current.get("run_id") is not None
    if not busy:
        recover_interrupted_runs()
    return {"hosts": hosts, "plans": plans, "runs": runs, "busy": busy, "settings": {"maxParallelLines": max_parallel_lines()}}


def latest_line(plan_id, host_id):
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


def run_detail(run_id):
    with connect() as conn:
        run = conn.execute("SELECT * FROM runs WHERE id=?", (run_id,)).fetchone()
        if not run:
            return None
        data = dict(run)
        data["steps"] = rows(
            conn,
            "SELECT * FROM run_steps WHERE run_id=? ORDER BY position, id",
            (run_id,),
        )
    total = len(data["steps"])
    done = sum(1 for s in data["steps"] if s["status"] in ("success", "failed", "skipped"))
    data["total"] = total
    data["done"] = done
    data["percent"] = int(done * 100 / total) if total else 0
    return data


def auth_options(host):
    if (host.get("password") or "").strip():
        return [
            "-o", "StrictHostKeyChecking=no",
            "-o", "UserKnownHostsFile=/dev/null",
            "-o", f"ConnectTimeout={app_setting('ssh_connect_timeout', 15)}",
            "-o", "PreferredAuthentications=publickey,password",
            "-o", "NumberOfPasswordPrompts=1",
        ]
    return [
        "-o", "BatchMode=yes",
        "-o", "StrictHostKeyChecking=no",
            "-o", "UserKnownHostsFile=/dev/null",
        "-o", f"ConnectTimeout={app_setting('ssh_connect_timeout', 15)}",
    ]


def command_env(host):
    env = os.environ.copy()
    password = (host.get("password") or "").strip()
    if not password:
        return env
    askpass = DATA / "askpass.sh"
    if not askpass.exists():
        with _lock:
            if not askpass.exists():
                askpass.write_text("#!/bin/sh\nprintf '%s\\n' \"$DEPLOY_SSH_PASSWORD\"\n", encoding="utf-8")
                askpass.chmod(0o700)
    env["DEPLOY_SSH_PASSWORD"] = password
    env["SSH_ASKPASS"] = str(askpass)
    env["SSH_ASKPASS_REQUIRE"] = "force"
    env.setdefault("DISPLAY", ":0")
    return env


def ssh_base(host):
    cmd = ["ssh", *auth_options(host), "-p", str(host["port"])]
    if host["identity_file"] and not (host.get("password") or "").strip():
        cmd.extend(["-i", host["identity_file"]])
    cmd.append(f"{host['username']}@{host['ip']}")
    return cmd


def build_argv(host, step):
    kind = step["kind"]
    if kind == "remote":
        command = step["command"].strip()
        if not command:
            raise ValueError("远程命令不能为空")
        return ssh_base(host) + [command], command
    if kind in ("upload", "download"):
        local_path = step["local_path"].strip()
        remote_path = step["remote_path"].strip()
        if not local_path or not remote_path:
            raise ValueError("文件传输需要本地路径和远端路径")
        remote = f"{host['username']}@{host['ip']}:{remote_path}"
        cmd = ["scp", *auth_options(host), "-P", str(host["port"])]
        if host["identity_file"] and not (host.get("password") or "").strip():
            cmd.extend(["-i", host["identity_file"]])
        if kind == "upload":
            cmd.insert(1, "-r")
            cmd.extend([local_path, remote])
            preview = f"scp -r {local_path} {remote}"
        else:
            cmd.extend([remote, local_path])
            preview = f"scp {remote} {local_path}"
        return cmd, preview
    if kind == "local":
        command = step["command"].strip()
        if not command:
            raise ValueError("本机命令不能为空")
        rendered = command.format(
            ip=host["ip"],
            port=host["port"],
            user=host["username"],
            name=host["name"],
        )
        return ["bash", "-lc", rendered], rendered
    raise ValueError(f"不支持的步骤类型：{kind}")


def update_step(step_id, **fields):
    keys = ", ".join(f"{k}=?" for k in fields)
    with _lock, connect() as conn:
        conn.execute(
            f"UPDATE run_steps SET {keys} WHERE id=?",
            (*fields.values(), step_id),
        )


def append_output(step_id, text):
    if not text:
        return
    with _lock, connect() as conn:
        conn.execute(
            "UPDATE run_steps SET output = CONCAT(IFNULL(output, ''), ?) WHERE id=?",
            (text, step_id),
        )


def recover_interrupted_runs():
    if _current.get("run_id"):
        return
    with _lock, connect() as conn:
        runs = rows(conn, "SELECT id FROM runs WHERE status='running'")
        for run in runs:
            conn.execute(
                """
                UPDATE run_steps
                SET status='skipped', output=CONCAT(IFNULL(output, ''), '\n任务已中断\n'), finished_at=?
                WHERE run_id=? AND status IN ('pending', 'running')
                """,
                (now(), run["id"]),
            )
            conn.execute(
                "UPDATE runs SET status='cancelled', message='服务重启，任务已中断', finished_at=? WHERE id=? AND status='running'",
                (now(), run["id"]),
            )


def finish_run(run_id, status, message):
    with _lock, connect() as conn:
        conn.execute(
            "UPDATE runs SET status=?, message=?, finished_at=? WHERE id=?",
            (status, message, now(), run_id),
        )


def skip_rest(run_id):
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


def read_until(proc, item_id, marker, timeout=None, collect=None, prefix=False):
    output_len = 0
    assert proc.stdout is not None
    fd = proc.stdout.fileno()
    deadline = time.time() + timeout if timeout else None
    pending = ""
    while True:
        if proc.poll() is not None and not pending:
            return None, output_len
        remain = None
        if deadline is not None:
            remain = deadline - time.time()
            if remain <= 0:
                try:
                    os.killpg(proc.pid, signal.SIGTERM)
                except ProcessLookupError:
                    pass
                raise TimeoutError("SSH 连接超时")
        ready, _, _ = select.select([fd], [], [], 1 if remain is None else min(1, remain))
        if not ready:
            if _current["cancel"]:
                try:
                    os.killpg(proc.pid, signal.SIGTERM)
                except ProcessLookupError:
                    pass
                return False, output_len
            continue
        try:
            chunk = os.read(fd, 4096)
        except BlockingIOError:
            continue
        if chunk == b"":
            return None, output_len
        pending += chunk.decode("utf-8", errors="replace")
        while "\n" in pending:
            line, pending = pending.split("\n", 1)
            line = line + "\n"
            if collect is not None:
                collect.append(line)
            stripped = line.strip()
            if prefix and stripped.startswith(marker):
                return stripped, output_len
            if stripped == marker:
                return True, output_len
            output_len += len(line)
            if item_id and output_len <= 200_000:
                append_output(item_id, line)
    return None, output_len


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
        text=False,
        bufsize=0,
        env=command_env(host),
        start_new_session=True,
    )
    proc.stdin.write(b"set +e\nexport DEPLOY_PREV_OUTPUT=\nexport DEPLOY_PREV_STATUS=0\nprintf '%s\n' __DEPLOY_READY__\n")
    proc.stdin.flush()
    startup = []
    ready, _ = read_until(proc, 0, "__DEPLOY_READY__", timeout=app_setting("ssh_ready_timeout", 20), collect=startup)
    if ready is not True or proc.poll() is not None:
        detail = "".join(startup).strip() or "没有收到远程终端响应"
        raise OSError("远程终端没有建立成功\n" + detail)
    shells[host["id"]] = proc
    shells[str(host["id"]) + ":n"] = 0
    return proc


def close_shell(shells, host_id):
    proc = shells.pop(host_id, None)
    shells.pop(str(host_id) + ":n", None)
    if not proc or proc.poll() is not None:
        return
    try:
        proc.stdin.write("exit\n")
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
printf '%s\\n' '{marker} '$DEPLOY_PREV_STATUS
"""
    proc.stdin.write(script)
    proc.stdin.flush()
    remember_proc(proc)
    seen, _ = read_until(proc, item_id, marker)
    code = 1
    if seen is True:
        last = ""
        # marker line was consumed by read_until only when exact strip match.
        # Status is appended after the marker text in the same line, so match differently.
        code = 0
    return seen, code


def latest_step(step):
    if not step or not step.get("id"):
        return step
    with connect() as conn:
        row = conn.execute("SELECT * FROM steps WHERE id=?", (step["id"],)).fetchone()
    return dict(row) if row else step


def run_host_line(run_id, items, hosts, steps):
    failure_messages = []
    stopped_hosts = set()
    shells = {}
    for item in items:
        if item["host_id"] in stopped_hosts:
            continue
        if _current["cancel"]:
            for host_id in list(shells):
                if isinstance(host_id, int):
                    close_shell(shells, host_id)
            update_step(item["id"], status="skipped", finished_at=now(), output="已手动停止\n")
            skip_host_rest(run_id, item["host_id"])
            return failure_messages
        host = hosts.get(item["host_id"])
        step = latest_step(steps.get(item["step_id"]))
        update_step(item["id"], status="running", started_at=now())
        if not host or not step:
            update_step(item["id"], status="failed", finished_at=now(), exit_code=1, output="目标或命令已不存在\n")
            message = "目标或命令已不存在"
            stopped_hosts.add(item["host_id"])
            if item.get("host_id") is not None:
                close_shell(shells, item["host_id"])
                skip_host_rest(run_id, item["host_id"])
            failure_messages.append(message)
            continue
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
                remember_proc(proc)
                output_len = 0
                captured = []
                assert proc.stdout is not None
                for line in proc.stdout:
                    output_len += len(line)
                    captured.append(line)
                    if output_len <= 200_000:
                        append_output(item["id"], line)
                    if _current["cancel"]:
                        try:
                            os.killpg(proc.pid, signal.SIGTERM)
                        except ProcessLookupError:
                            pass
                        break
                code = proc.wait()
                forget_proc(proc)
                if code == 0 and "error" in "".join(captured).lower():
                    code = 1
                    append_output(item["id"], "\n输出中包含 error，已标红并停止后续步骤\n")
        except (ValueError, OSError) as exc:
            update_step(item["id"], status="failed", finished_at=now(), exit_code=1, output=str(exc) + "\n")
            message = str(exc)
            stopped_hosts.add(item["host_id"])
            if item.get("host_id") is not None:
                close_shell(shells, item["host_id"])
                skip_host_rest(run_id, item["host_id"])
            failure_messages.append(message)
            continue
        if _current["cancel"]:
            for host_id in list(shells):
                if isinstance(host_id, int):
                    close_shell(shells, host_id)
            update_step(item["id"], status="failed", finished_at=now(), exit_code=code if isinstance(code, int) else 1)
            append_output(item["id"], "\n已手动停止\n")
            skip_host_rest(run_id, item["host_id"])
            return failure_messages
        if code != 0:
            update_step(item["id"], status="failed", finished_at=now(), exit_code=code)
            append_output(item["id"], f"\n退出码 {code}，已停止后续步骤\n")
            message = f"{item['host_label']} 执行失败，退出码 {code}"
            stopped_hosts.add(item["host_id"])
            if item.get("host_id") is not None:
                close_shell(shells, item["host_id"])
                skip_host_rest(run_id, item["host_id"])
            failure_messages.append(message)
            continue
        update_step(item["id"], status="success", finished_at=now(), exit_code=0)
    for host_id in list(shells):
        if isinstance(host_id, int):
            close_shell(shells, host_id)
    return failure_messages


def execute_run(run_id, limit=None):
    with connect() as conn:
        items = rows(
            conn,
            "SELECT * FROM run_steps WHERE run_id=? AND status='pending' ORDER BY position, id",
            (run_id,),
        )
        hosts = {h["id"]: h for h in rows(conn, "SELECT * FROM hosts")}
        steps = {s["id"]: s for s in rows(conn, "SELECT * FROM steps")}
    groups = {}
    order = []
    for item in items:
        host_id = item["host_id"]
        if host_id not in groups:
            groups[host_id] = []
            order.append(host_id)
        groups[host_id].append(item)
    failure_messages = []
    lock = threading.Lock()
    limit = max(1, int(limit or max_parallel_lines()))
    print(f"本次同时执行上限：{limit}", flush=True)
    slots = threading.Semaphore(limit)

    def worker(host_items):
        with slots:
            if _current["cancel"]:
                return
            try:
                messages = run_host_line(run_id, host_items, hosts, steps)
            except Exception as exc:
                host_id = host_items[0]["host_id"] if host_items else None
                if host_id is not None:
                    skip_host_rest(run_id, host_id)
                messages = [str(exc)]
            if messages:
                with lock:
                    failure_messages.extend(messages)

    threads = [threading.Thread(target=worker, args=(groups[host_id],), daemon=True) for host_id in order]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()
    if _current["cancel"]:
        skip_rest(run_id)
        finish_run(run_id, "cancelled", "已手动停止")
    elif failure_messages:
        finish_run(run_id, "failed", "；".join(dict.fromkeys(failure_messages)))
    else:
        finish_run(run_id, "success", "全部完成")
    _current["run_id"] = None
    _current["cancel"] = False
    _current["procs"] = []


def run_remote(proc, shells, host, item_id, command):
    count = int(shells.get(str(host["id"]) + ":n", 0)) + 1
    shells[str(host["id"]) + ":n"] = count
    token = f"DEPLOY_DONE_{item_id}_{count}"
    marker = f"__{token}__"
    script = (
        f"cat > \"/tmp/{token}.cmd\" <<'END_{token}'\n"
        f"{command}\n"
        f"END_{token}\n"
        f"source \"/tmp/{token}.cmd\" > \"/tmp/{token}.out\" 2>&1\n"
        f"export DEPLOY_PREV_STATUS=$?\n"
        f"cat \"/tmp/{token}.out\"\n"
        f"export DEPLOY_PREV_OUTPUT=\"$(cat \"/tmp/{token}.out\")\"\n"
        f"export DEPLOY_OUTPUT_{count}=\"$DEPLOY_PREV_OUTPUT\"\n"
        f"rm -f \"/tmp/{token}.cmd\" \"/tmp/{token}.out\"\n"
        f"printf '%s\\n' \"{marker} $DEPLOY_PREV_STATUS\"\n"
    )
    remember_proc(proc)
    captured = []
    data = script.encode()
    sent = 0
    fd_in = proc.stdin.fileno()
    fd_out = proc.stdout.fileno()
    import fcntl as _fcntl
    _fcntl.fcntl(fd_in, _fcntl.F_SETFL, _fcntl.fcntl(fd_in, _fcntl.F_GETFL) | os.O_NONBLOCK)
    pending = ""
    matched = None
    deadline = time.time() + app_setting("command_timeout", 120)
    try:
        while matched is None:
            if time.time() > deadline:
                raise TimeoutError("命令结果超时")
            readable, _, _ = select.select([fd_out], [], [], 0.2)
            if fd_out in readable:
                chunk = os.read(fd_out, 4096)
                if chunk == b"" and proc.poll() is not None:
                    break
                pending += chunk.decode("utf-8", errors="replace")
                while "\n" in pending:
                    line, pending = pending.split("\n", 1)
                    line += "\n"
                    stripped = line.strip()
                    if stripped.startswith(marker + " "):
                        matched = stripped
                        break
                    captured.append(line)
                    if len("".join(captured)) <= 200_000:
                        append_output(item_id, line)
            if sent < len(data):
                try:
                    sent += os.write(fd_in, data[sent:sent + 1024])
                except BlockingIOError:
                    pass
    finally:
        forget_proc(proc)
    if not isinstance(matched, str):
        return 1
    try:
        code = int(matched.rsplit(" ", 1)[-1])
    except ValueError:
        code = 1
    body = "".join(line for line in captured if not line.strip().startswith(marker))
    if code == 0 and "error" in body.lower():
        append_output(item_id, "\n输出中包含 error，已标红并停止后续步骤\n")
        return 1
    return code


def live_procs():
    procs = [proc for proc in (_current.get("procs") or []) if proc and proc.poll() is None]
    current = _current.get("proc")
    if current and current.poll() is None and current not in procs:
        procs.append(current)
    return procs


def start_run(plan_id, host_ids, from_step_id=None, max_parallel=None, user=None):
    if _current["run_id"]:
        if live_procs():
            raise RuntimeError("已有任务正在执行")
        finish_run(_current["run_id"], "cancelled", "上次任务已中断")
        _current["run_id"] = None
        _current["cancel"] = False
        _current["proc"] = None
        _current["procs"] = []
    with connect() as conn:
        plan = conn.execute("SELECT * FROM plans WHERE id=?", (plan_id,)).fetchone()
        if not plan:
            raise ValueError("项目不存在")
        if user is not None and not can_plan(conn, user, plan_id):
            raise ValueError("没有这个画布的权限")
        disabled = {row["host_id"] for row in conn.execute("SELECT host_id FROM line_flags WHERE plan_id=? AND disabled=1", (plan_id,)).fetchall()}
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
        cur = conn.execute(
            "INSERT INTO runs (plan_id, plan_name, status, message, created_at) VALUES (?, ?, 'running', '', ?)",
            (plan_id, plan["name"], now()),
        )
        run_id = cur.lastrowid
        position = 1
        for host in hosts:
            steps = [dict(row) for row in conn.execute("SELECT * FROM steps WHERE plan_id=? AND host_id=? ORDER BY position, id", (plan_id, host["id"])).fetchall()]
            if not steps:
                raise ValueError(host["name"] + " 这条线还没有自己的命令")
            resume_at = None
            if from_step_id:
                matched = [step for step in steps if step["id"] == from_step_id]
                if not matched:
                    raise ValueError("没有找到要继续的命令")
                resume_at = matched[0]["position"]
            force_row = conn.execute(
                "SELECT force_run FROM line_flags WHERE plan_id=? AND host_id=?",
                (plan_id, host["id"]),
            ).fetchone()
            force_run = bool(force_row and force_row.get("force_run"))
            if not from_step_id and not force_run:
                finished = True
                for step in steps:
                    prev = conn.execute(
                        "SELECT status FROM run_steps WHERE step_id=? ORDER BY id DESC LIMIT 1",
                        (step["id"],),
                    ).fetchone()
                    if step.get("disabled"):
                        continue
                    if not prev or prev["status"] != "success":
                        finished = False
                        break
                if finished:
                    continue
            if force_run:
                conn.execute(
                    "UPDATE line_flags SET force_run=0 WHERE plan_id=? AND host_id=?",
                    (plan_id, host["id"]),
                )
            for step in steps:
                preview = step["command"] or f"{step['kind']} {step['local_path']} -> {step['remote_path']}"
                status = "pending"
                output = ""
                exit_code = None
                started = None
                finished = None
                prev = conn.execute(
                    "SELECT status, output, preview FROM run_steps WHERE step_id=? ORDER BY id DESC LIMIT 1",
                    (step["id"],),
                ).fetchone()
                same_command = prev and (prev["preview"] or "") == preview
                keep_success = (not force_run) and prev and prev["status"] == "success" and same_command and not (resume_at and step["position"] >= resume_at)
                if step.get("disabled"):
                    status = "skipped"
                    output = "已禁用，跳过"
                    exit_code = 0
                    started = now()
                    finished = now()
                elif (resume_at and step["position"] < resume_at) or keep_success:
                    status = "success"
                    output = (prev["output"] if prev and prev["output"] else "")
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
                position += 1
        if position == 1:
            conn.execute("DELETE FROM runs WHERE id=?", (run_id,))
            raise ValueError("已完成的线不会重复执行，请先点「刷新这条线」")
    _current["run_id"] = run_id
    _current["cancel"] = False
    if max_parallel is not None:
        max_parallel = save_max_parallel_lines(max_parallel)
    threading.Thread(target=execute_run, args=(run_id, max_parallel), daemon=True).start()
    return run_id




def read_ai_config():
    path = DATA / "ai.json"
    if not path.is_file():
        return {"base_url": "", "api_key": "", "model": "", "timeout": 60}
    cfg = json.loads(path.read_text(encoding="utf-8"))
    return {
        "base_url": str(cfg.get("base_url") or ""),
        "api_key": str(cfg.get("api_key") or ""),
        "model": str(cfg.get("model") or ""),
        "timeout": int(cfg.get("timeout") or 60),
    }


def load_ai_config():
    cfg = read_ai_config()
    if not cfg["base_url"].strip() or not cfg["api_key"].strip() or not cfg["model"].strip():
        raise RuntimeError("请先在左侧「AI集成」里填写接口地址、密钥和模型")
    return cfg


def ai_complete(messages):
    import urllib.request
    import urllib.error
    cfg = load_ai_config()
    url = str(cfg["base_url"]).rstrip("/") + "/chat/completions"
    body = json.dumps({"model": cfg["model"], "temperature": 0.2, "messages": messages}, ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request(url, data=body, headers={"Authorization": "Bearer " + str(cfg["api_key"]), "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=int(cfg.get("timeout") or 60)) as resp:
            data = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")[:300]
        raise RuntimeError("AI 接口调用失败：" + detail)
    return data["choices"][0]["message"]["content"]


def parse_ai_json(text):
    raw = text.strip()
    if raw.startswith("```"):
        raw = raw.split("\n", 1)[-1]
        raw = raw.rsplit("```", 1)[0]
    raw = raw.strip()
    try:
        data = json.loads(raw)
    except json.JSONDecodeError:
        begin = raw.find("{")
        finish = raw.rfind("}")
        if begin < 0 or finish <= begin:
            raise ValueError("AI 没有返回可识别的草稿")
        data = json.loads(raw[begin:finish + 1])
    if isinstance(data, list):
        return {"summary": "", "lines": data}
    return data



def chinese_number(text):
    if not text:
        return None
    if text.isdigit():
        return int(text)
    digits = {"一": 1, "二": 2, "三": 3, "四": 4, "五": 5, "六": 6, "七": 7, "八": 8, "九": 9}
    if text == "十":
        return 10
    if text.startswith("十"):
        return 10 + digits.get(text[1:], 0)
    if "十" in text:
        left, right = text.split("十", 1)
        return digits.get(left, 1) * 10 + digits.get(right, 0)
    return digits.get(text)


def chinese_index(prompt):
    import re
    matched = re.search(r"第\s*([0-9]+|[一二三四五六七八九十]+)\s*条", prompt)
    return chinese_number(matched.group(1)) if matched else None


def chinese_count(prompt):
    import re
    matched = re.search(r"复制\s*([0-9]+|[一二三四五六七八九十]+)\s*条", prompt)
    return chinese_number(matched.group(1)) if matched else None


def kind_name(value):
    text = str(value or "").strip().lower()
    if text in ("remote", "command", "cmd", "命令", "远程命令"):
        return "remote"
    if text in ("upload", "上传"):
        return "upload"
    if text in ("download", "下载"):
        return "download"
    return ""


def resolve_host(line, hosts):
    by_id = {int(host["id"]): host for host in hosts}
    raw = line.get("hostId", line.get("host_id", line.get("host")))
    text = str(raw or line.get("hostName") or line.get("name") or "").strip()
    if text.isdigit() and int(text) in by_id:
        return by_id[int(text)]
    for index, host in enumerate(hosts, start=1):
        if text in (str(index), "第%d条" % index, host["name"], host["ip"]):
            return host
    return None


def normalize_draft(plan_id, draft, hosts):
    lines = []
    warnings = []
    for line in draft.get("lines") or []:
        host = resolve_host(line, hosts)
        if not host:
            warnings.append("有一条线没有对应主机，已忽略")
            continue
        host_id = int(host["id"])
        steps = []
        for step in line.get("steps") or []:
            kind = kind_name(step.get("kind") or step.get("type"))
            if not kind:
                warnings.append(host["name"] + " 有不支持的步骤，已忽略")
                continue
            command = str(step.get("command") or step.get("cmd") or "")
            local_path = str(step.get("localPath") or step.get("local_path") or "")
            remote_path = str(step.get("remotePath") or step.get("remote_path") or "")
            if kind == "remote" and not command.strip():
                warnings.append(host["name"] + " 有空命令，已忽略")
                continue
            if kind in ("upload", "download") and (not local_path.strip() or not remote_path.strip()):
                warnings.append(host["name"] + " 有缺少路径的传输步骤，已忽略")
                continue
            steps.append({
                "kind": kind,
                "note": str(step.get("note") or "")[:255],
                "command": command,
                "localPath": local_path,
                "remotePath": remote_path,
            })
        if steps:
            lines.append({"hostId": host_id, "hostName": host["name"], "steps": steps})
    if not lines:
        raise ValueError("没有生成可保存的步骤。" + (" ".join(warnings) if warnings else "请说明要复制到哪几台主机"))
    return {"planId": plan_id, "summary": str(draft.get("summary") or ""), "warnings": warnings, "lines": lines}


def session_user(token):
    if not token:
        return None
    with connect() as conn:
        row = conn.execute(
            """
            SELECT users.id, users.username, users.is_admin
            FROM sessions
            JOIN users ON users.id = sessions.user_id
            WHERE sessions.token=? AND sessions.expires_at>?
            """,
            (token, now()),
        ).fetchone()
    return dict(row) if row else None


def read_session_token(header):
    for part in (header or "").split(";"):
        name, _, value = part.strip().partition("=")
        if name == "deploy_session":
            return value
    return ""


def session_cookie(token, max_age):
    return f"deploy_session={token}; Path=/; HttpOnly; SameSite=Lax; Max-Age={max_age}"


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        return

    def send_json(self, payload, status=200, headers=None):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        try:
            self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            for key, value in headers or []:
                self.send_header(key, value)
            self.end_headers()
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            return

    def read_json(self):
        length = int(self.headers.get("Content-Length", "0"))
        raw = self.rfile.read(length) if length else b"{}"
        return json.loads(raw.decode("utf-8"))

    def do_GET(self):
        path = urlparse(self.path).path
        if path == "/":
            return self.serve_file(PUBLIC / "index.html", "text/html; charset=utf-8")
        if path.startswith("/static/"):
            name = path.removeprefix("/static/")
            file = PUBLIC / name
            if file.is_file() and file.resolve().parent == PUBLIC.resolve():
                kind = "text/css; charset=utf-8" if name.endswith(".css") else "text/javascript; charset=utf-8"
                return self.serve_file(file, kind)
        if path == "/api/me":
            user = self.current_user()
            if not user:
                return self.send_json({"error": "未登录"}, 401)
            return self.send_json({"id": user["id"], "username": user["username"], "isAdmin": bool(user.get("is_admin"))})
        user = self.require_user()
        if not user:
            return
        if path == "/api/users":
            return self.list_users()
        if path == "/api/ai/config":
            if not user.get("is_admin"):
                return self.send_json({"error": "只有管理员可以配置 AI"}, 403)
            return self.send_json(read_ai_config())
        if path == "/api/state":
            return self.send_json(public_state(user))
        if len([p for p in path.split("/") if p]) == 4 and path.startswith("/api/hosts/") and path.endswith("/usage"):
            host_id = int([p for p in path.split("/") if p][2])
            with connect() as conn:
                plans = rows(conn, """
                    SELECT DISTINCT plans.id, plans.name
                    FROM plans
                    JOIN plan_hosts ON plan_hosts.plan_id = plans.id
                    WHERE plan_hosts.host_id=?
                    ORDER BY plans.id
                """, (host_id,))
            return self.send_json({"plans": plans})
        if path.startswith("/api/lines/"):
            from urllib.parse import parse_qs
            try:
                host_id = int(path.rstrip("/").rsplit("/", 1)[-1])
                plan_id = int(parse_qs(urlparse(self.path).query).get("planId", ["0"])[0])
            except ValueError:
                return self.send_json({"error": "无效参数"}, 400)
            if not can_plan_for(user, plan_id):
                return self.send_json({"error": "没有这个画布的权限"}, 403)
            data = latest_line(plan_id, host_id)
            if data is None:
                return self.send_json({"error": "目标不存在"}, 404)
            return self.send_json(data)
        if path.startswith("/api/runs/"):
            try:
                run_id = int(path.rsplit("/", 1)[-1])
            except ValueError:
                return self.send_json({"error": "无效任务"}, 400)
            data = run_detail(run_id)
            if not data:
                return self.send_json({"error": "任务不存在"}, 404)
            if not can_plan_for(user, data.get("plan_id")):
                return self.send_json({"error": "没有这个画布的权限"}, 403)
            return self.send_json(data)
        self.send_json({"error": "未找到"}, 404)

    def serve_file(self, file, content_type):
        if not file.is_file():
            return self.send_json({"error": "页面缺失"}, 404)
        body = file.read_bytes()
        try:
            self.send_response(200)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            return

    def do_POST(self):
        path = urlparse(self.path).path
        try:
            payload = self.read_json() if path != "/api/logout" else {}
            if path == "/api/login":
                return self.login(payload)
            if path == "/api/logout":
                return self.logout()
            if path == "/api/password":
                user = self.require_user()
                if not user:
                    return
                return self.change_password(user, payload)
            if not self.require_user():
                return
            if path == "/api/users":
                return self.create_user(payload)
            if path == "/api/users/grants":
                return self.save_grants(payload)
            if path == "/api/hosts":
                return self.save_host(payload)
            if path == "/api/plans":
                return self.save_plan(payload)
            if path == "/api/plans/copy":
                return self.copy_plan(payload)
            if path == "/api/line-flags":
                return self.save_line_flag(payload)
            if path == "/api/line-flags/all":
                return self.set_all_lines(payload)
            if path == "/api/ai/config":
                return self.save_ai_config(payload)
            if path == "/api/ai/draft":
                return self.ai_draft(payload)
            if path == "/api/ai/apply":
                return self.ai_apply(payload)
            if path == "/api/ai/undo":
                return self.ai_undo(payload)
            if path == "/api/lines/copy":
                return self.copy_line(payload)
            if path == "/api/steps/reorder":
                return self.reorder_steps(payload)
            if path == "/api/steps/disabled":
                return self.set_step_disabled(payload)
            if path == "/api/steps":
                return self.save_step(payload)
            if path == "/api/runs":
                run_id = start_run(int(payload["planId"]), [int(x) for x in payload["hostIds"]], int(payload["fromStepId"]) if payload.get("fromStepId") else None, int(payload["maxParallel"]) if payload.get("maxParallel") else None, self.user)
                return self.send_json({"id": run_id})
            if path.endswith("/cancel") and path.startswith("/api/runs/"):
                run_id = int(path.split("/")[3])
                detail = run_detail(run_id)
                if not detail or not can_plan_for(self.user, detail.get("plan_id")):
                    return self.send_json({"error": "没有这个画布的权限"}, 403)
                if _current["run_id"] != run_id:
                    return self.send_json({"error": "这个任务没有在执行"}, 400)
                _current["cancel"] = True
                procs = list(_current.get("procs") or [])
                if _current.get("proc") and _current["proc"] not in procs:
                    procs.append(_current["proc"])
                for proc in procs:
                    if proc and proc.poll() is None:
                        try:
                            os.killpg(proc.pid, signal.SIGTERM)
                        except ProcessLookupError:
                            pass
                return self.send_json({"ok": True})
        except (ValueError, RuntimeError, KeyError, json.JSONDecodeError) as exc:
            return self.send_json({"error": str(exc)}, 400)
        self.send_json({"error": "未找到"}, 404)

    def save_host(self, payload):
        name = payload.get("name", "").strip()
        ip = payload.get("ip", "").strip()
        username = payload.get("username", "").strip()
        port = int(payload.get("port") or 22)
        identity = payload.get("identityFile", "").strip()
        password = payload.get("password", "")
        if not name or not ip or not username:
            raise ValueError("名称、IP 和用户名都要填写")
        if port < 1 or port > 65535:
            raise ValueError("端口不正确")
        with connect() as conn:
            if payload.get("id"):
                if str(password).strip():
                    conn.execute(
                        """
                        UPDATE hosts
                        SET name=?, ip=?, port=?, username=?, identity_file=?, password=?
                        WHERE id=?
                        """,
                        (name, ip, port, username, identity, password, int(payload["id"])),
                    )
                else:
                    conn.execute(
                        """
                        UPDATE hosts
                        SET name=?, ip=?, port=?, username=?, identity_file=?
                        WHERE id=?
                        """,
                        (name, ip, port, username, identity, int(payload["id"])),
                    )
                host_id = int(payload["id"])
            else:
                cur = conn.execute(
                    """
                    INSERT INTO hosts (name, ip, port, username, identity_file, password, created_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?)
                    """,
                    (name, ip, port, username, identity, password or "", now()),
                )
                host_id = cur.lastrowid
                plan_id = int(payload.get("planId") or 0)
                if plan_id:
                    if not can_plan(conn, self.user, plan_id):
                        raise ValueError("没有这个画布的权限")
                    conn.execute("INSERT IGNORE INTO plan_hosts (plan_id, host_id) VALUES (?, ?)", (plan_id, host_id))
        self.send_json({"id": host_id})

    def reorder_steps(self, payload):
        plan_id = int(payload.get("planId") or 0)
        host_id = int(payload.get("hostId") or 0)
        step_ids = [int(item) for item in payload.get("stepIds") or []]
        if not can_plan_for(self.user, plan_id):
            raise ValueError("没有这个画布的权限")
        with connect() as conn:
            existing = [row["id"] for row in conn.execute(
                "SELECT id FROM steps WHERE plan_id=? AND host_id=? ORDER BY position, id",
                (plan_id, host_id),
            ).fetchall()]
            if sorted(existing) != sorted(step_ids):
                raise ValueError("这条线上的命令已变化，请刷新后再拖动")
            for index, step_id in enumerate(step_ids, start=1):
                conn.execute(
                    "UPDATE steps SET position=? WHERE id=? AND plan_id=? AND host_id=?",
                    (index, step_id, plan_id, host_id),
                )
        self.send_json({"ok": True})

    def set_step_disabled(self, payload):
        step_id = int(payload.get("id") or 0)
        disabled = 1 if payload.get("disabled") else 0
        with connect() as conn:
            step = conn.execute("SELECT plan_id FROM steps WHERE id=?", (step_id,)).fetchone()
            if not step or not can_plan(conn, self.user, step["plan_id"]):
                raise ValueError("没有这个步骤")
            conn.execute("UPDATE steps SET disabled=? WHERE id=?", (disabled, step_id))
        self.send_json({"ok": True})

    def save_ai_config(self, payload):
        if not self.user.get("is_admin"):
            return self.send_json({"error": "只有管理员可以配置 AI"}, 403)
        cfg = {
            "base_url": str(payload.get("base_url") or "").strip(),
            "api_key": str(payload.get("api_key") or "").strip(),
            "model": str(payload.get("model") or "").strip(),
            "timeout": max(10, int(payload.get("timeout") or 60)),
        }
        if not cfg["base_url"] or not cfg["api_key"] or not cfg["model"]:
            raise ValueError("请填写接口地址、密钥和模型")
        (DATA / "ai.json").write_text(json.dumps(cfg, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        return self.send_json({"ok": True})

    def disable_steps_draft(self, plan_id, prompt, hosts):
        import re
        if "禁用" not in prompt:
            return None
        number = re.search(r"(\d{3,})", prompt)
        if not number:
            raise ValueError("请写明要禁用哪台主机，例如 10069")
        token = number.group(1)
        matched = [host for host in hosts if token in host["name"] or token == str(host["ip"]) or token == str(host["port"])]
        if len(matched) != 1:
            raise ValueError("没有唯一匹配到包含 %s 的主机" % token)
        host = matched[0]
        phrase = re.search(r"的(.+)$", prompt)
        title = phrase.group(1).strip() if phrase else ""
        title = re.sub(r"(这个|该)?(命令|步骤)$", "", title).strip()
        if not title:
            raise ValueError("请写明要禁用哪一步，例如 拷贝模型文件")
        with connect() as conn:
            steps = rows(conn, "SELECT id, kind, note, command, local_path, remote_path, disabled FROM steps WHERE plan_id=? AND host_id=? ORDER BY position, id", (plan_id, host["id"]))
        hits = [step for step in steps if title in (step["note"] or "") or title in (step["command"] or "") or title in (step["local_path"] or "")]
        if not hits:
            raise ValueError("%s 上没有找到「%s」" % (host["name"], title))
        return {
            "planId": plan_id,
            "summary": "禁用 %s 的「%s」，不会新增步骤" % (host["name"], title),
            "warnings": [],
            "lines": [{
                "action": "disable",
                "hostId": host["id"],
                "hostName": host["name"],
                "steps": [{
                    "id": step["id"],
                    "kind": step["kind"],
                    "note": step["note"] or "",
                    "command": step["command"] or "",
                    "localPath": step["local_path"] or "",
                    "remotePath": step["remote_path"] or "",
                } for step in hits],
            }],
        }

    def copy_lines_draft(self, plan_id, prompt, hosts):
        import re
        index = chinese_index(prompt)
        copies = chinese_count(prompt)
        if not index or not copies:
            return None
        if index < 1 or index > len(hosts) or copies < 1:
            raise ValueError("没有找到要复制的第 %d 条线" % index)
        host = hosts[index - 1]
        with connect() as conn:
            steps = rows(conn, "SELECT kind, note, command, local_path, remote_path FROM steps WHERE plan_id=? AND host_id=? ORDER BY position, id", (plan_id, host["id"]))
        if not steps:
            raise ValueError("第 %d 条线上没有可复制的步骤" % index)
        payload_steps = [{
            "kind": step["kind"],
            "note": step["note"] or "",
            "command": step["command"] or "",
            "localPath": step["local_path"] or "",
            "remotePath": step["remote_path"] or "",
        } for step in steps]
        lines = []
        for number in range(1, copies + 1):
            lines.append({
                "copyFromHostId": host["id"],
                "hostName": "%s 副本%d" % (host["name"], number),
                "steps": payload_steps,
            })
        return {
            "planId": plan_id,
            "summary": "将第%d条复制成 %d 条新线，保存后会出现在画布底部" % (index, copies),
            "warnings": [],
            "lines": lines,
        }

    def ai_draft(self, payload):
        plan_id = int(payload.get("planId") or 0)
        prompt = str(payload.get("prompt") or "").strip()
        if not prompt:
            raise ValueError("请先描述要生成的流水线")
        if not can_plan_for(self.user, plan_id):
            raise ValueError("没有这个画布的权限")
        with connect() as conn:
            hosts = rows(conn, """
                SELECT hosts.id, hosts.name, hosts.ip, hosts.port, hosts.username
                FROM hosts JOIN plan_hosts ON plan_hosts.host_id = hosts.id
                WHERE plan_hosts.plan_id=? ORDER BY hosts.id
            """, (plan_id,))
        if not hosts:
            raise ValueError("请先在这个项目里添加主机，再让 AI 起草")
        disabled = self.disable_steps_draft(plan_id, prompt, hosts)
        if disabled:
            return self.send_json(disabled)
        copied = self.copy_lines_draft(plan_id, prompt, hosts)
        if copied:
            return self.send_json(copied)
        lines = []
        with connect() as conn:
            for index, host in enumerate(hosts, start=1):
                steps = rows(
                    conn,
                    "SELECT position, kind, note, command, local_path, remote_path FROM steps WHERE plan_id=? AND host_id=? ORDER BY position, id",
                    (plan_id, host["id"]),
                )
                brief = "；".join(
                    (step["note"] or step["kind"]) + ":" + (step["command"] or (step["local_path"] + "->" + step["remote_path"]))[:40]
                    for step in steps
                ) or "暂无步骤"
                lines.append("第%d条 hostId=%s %s %s@%s:%s 现有步骤：%s" % (index, host["id"], host["name"], host["username"], host["ip"], host["port"], brief))
        host_text = "\n".join(lines)
        system = (
            "你是部署流水线起草助手。只输出 JSON，不要解释，不要建议执行。"
            "JSON 包含 summary 和 lines。每条线包含 hostId 和 steps。"
            "每个步骤包含 kind、note、command、localPath、remotePath。kind 只能是 remote、upload 或 download。"
            "用户说第N条时，对应下面列表里的第N条，hostId 必须使用该条的 hostId。"
            "复制整条流水线时不要追加到已有主机。输出 copyFromHostId 为源主机，并为每一份复制单独一条线。"
            "remote 必须有 command。upload 和 download 必须有 localPath 与 remotePath。不要编造密码。"
        )
        text = ai_complete([
            {"role": "system", "content": system},
            {"role": "user", "content": "当前项目的线：\n" + host_text + "\n\n需求：\n" + prompt},
        ])
        draft = normalize_draft(plan_id, parse_ai_json(text), hosts)
        return self.send_json(draft)

    def ai_undo(self, payload):
        change = _ai_undo.get(self.user["id"])
        if not change:
            raise ValueError("没有可撤回的 AI 保存")
        plan_id = int(payload.get("planId") or change["planId"])
        if plan_id != change["planId"] or not can_plan_for(self.user, plan_id):
            raise ValueError("没有这个画布的权限")
        with connect() as conn:
            for step_id in change.get("enableStepIds") or []:
                conn.execute("UPDATE steps SET disabled=0 WHERE id=? AND plan_id=?", (step_id, plan_id))
            for step_id in change["stepIds"]:
                conn.execute("DELETE FROM steps WHERE id=? AND plan_id=?", (step_id, plan_id))
            for host_id in change["hostIds"]:
                conn.execute("DELETE FROM steps WHERE plan_id=? AND host_id=?", (plan_id, host_id))
                conn.execute("DELETE FROM plan_hosts WHERE plan_id=? AND host_id=?", (plan_id, host_id))
                conn.execute("DELETE FROM hosts WHERE id=?", (host_id,))
        _ai_undo.pop(self.user["id"], None)
        return self.send_json({"ok": True})

    def ai_apply(self, payload):
        plan_id = int(payload.get("planId") or 0)
        if not can_plan_for(self.user, plan_id):
            raise ValueError("没有这个画布的权限")
        lines = payload.get("lines") or []
        if not lines:
            raise ValueError("没有可保存的草稿")
        saved = 0
        created_hosts = []
        created_steps = []
        with connect() as conn:
            for line in lines:
                if line.get("action") == "disable":
                    for step in line.get("steps") or []:
                        step_id = int(step.get("id") or 0)
                        row = conn.execute("SELECT id, disabled FROM steps WHERE id=? AND plan_id=?", (step_id, plan_id)).fetchone()
                        if not row:
                            raise ValueError("要禁用的步骤不存在")
                        conn.execute("UPDATE steps SET disabled=1 WHERE id=?", (step_id,))
                        created_steps.append(step_id)
                        saved += 1
                    continue
                source_id = int(line.get("copyFromHostId") or 0)
                if source_id:
                    source = conn.execute("SELECT * FROM hosts WHERE id=?", (source_id,)).fetchone()
                    if not source:
                        raise ValueError("要复制的主机不存在")
                    cur = conn.execute(
                        """
                        INSERT INTO hosts (name, ip, port, username, identity_file, password, created_at)
                        VALUES (?, ?, ?, ?, ?, ?, ?)
                        """,
                        (str(line.get("hostName") or (source["name"] + " 副本")), source["ip"], source["port"], source["username"], source["identity_file"], source["password"], now()),
                    )
                    host_id = cur.lastrowid
                    created_hosts.append(host_id)
                    conn.execute("INSERT IGNORE INTO plan_hosts (plan_id, host_id) VALUES (?, ?)", (plan_id, host_id))
                else:
                    host_id = int(line.get("hostId") or 0)
                    host = conn.execute("SELECT id, name FROM hosts WHERE id=?", (host_id,)).fetchone()
                    if not host:
                        raise ValueError("主机不存在")
                for step in line.get("steps") or []:
                    kind = step.get("kind")
                    if kind not in ("remote", "upload", "download"):
                        continue
                    position = conn.execute(
                        "SELECT COALESCE(MAX(position), 0) + 1 AS n FROM steps WHERE plan_id=? AND host_id=?",
                        (plan_id, host_id),
                    ).fetchone()["n"]
                    cur = conn.execute(
                        """
                        INSERT INTO steps (plan_id, host_id, position, kind, command, local_path, remote_path, note)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                        """,
                        (
                            plan_id,
                            host_id,
                            position,
                            kind,
                            str(step.get("command") or ""),
                            str(step.get("localPath") or ""),
                            str(step.get("remotePath") or ""),
                            str(step.get("note") or "")[:255],
                        ),
                    )
                    saved += 1
                    created_steps.append(cur.lastrowid)
        if not saved:
            raise ValueError("没有可保存的步骤")
        undo_steps = [] if any(line.get("action") == "disable" for line in lines) else created_steps
        undo_enable = created_steps if any(line.get("action") == "disable" for line in lines) else []
        _ai_undo[self.user["id"]] = {"planId": plan_id, "hostIds": created_hosts, "stepIds": undo_steps, "enableStepIds": undo_enable}
        return self.send_json({"ok": True, "saved": saved, "canUndo": True})

    def save_step(self, payload):
        plan_id = int(payload.get("planId") or 0)
        if not can_plan_for(self.user, plan_id):
            raise ValueError("没有这个画布的权限")
        host_id = int(payload.get("hostId") or 0)
        kind = payload.get("kind")
        if kind not in ("remote", "upload", "download", "local"):
            raise ValueError("步骤类型不正确")
        if not plan_id or not host_id:
            raise ValueError("请选择项目和对应的主机")
        command = str(payload.get("command") or "")
        local_path = str(payload.get("localPath") or "")
        remote_path = str(payload.get("remotePath") or "")
        with connect() as conn:
            if payload.get("id"):
                conn.execute(
                    """
                    UPDATE steps
                    SET kind=?, command=?, local_path=?, remote_path=?, host_id=?, note=?
                    WHERE id=? AND plan_id=?
                    """,
                    (kind, command, local_path, remote_path, host_id, str(payload.get("note") or ""), int(payload["id"]), plan_id),
                )
                step_id = int(payload["id"])
            else:
                position = conn.execute(
                    "SELECT COALESCE(MAX(position), 0) + 1 AS n FROM steps WHERE plan_id=? AND host_id=?",
                    (plan_id, host_id),
                ).fetchone()["n"]
                cur = conn.execute(
                    """
                    INSERT INTO steps (plan_id, host_id, position, kind, command, local_path, remote_path, note)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (plan_id, host_id, position, kind, command, local_path, remote_path, str(payload.get("note") or "")),
                )
                step_id = cur.lastrowid
        self.send_json({"id": step_id})

    def copy_plan(self, payload):
        plan_id = int(payload.get("id") or 0)
        if not can_plan_for(self.user, plan_id):
            raise ValueError("没有这个画布的权限")
        with connect() as conn:
            plan = conn.execute("SELECT * FROM plans WHERE id=?", (plan_id,)).fetchone()
            if not plan:
                raise ValueError("项目不存在")
            cur = conn.execute(
                "INSERT INTO plans (name, owner_id, created_at) VALUES (?, ?, ?)",
                (plan["name"] + " 副本", self.user["id"], now()),
            )
            new_id = cur.lastrowid
            grant_plan(conn, self.user["id"], new_id)
            for row in conn.execute("SELECT host_id FROM plan_hosts WHERE plan_id=?", (plan_id,)).fetchall():
                conn.execute("INSERT IGNORE INTO plan_hosts (plan_id, host_id) VALUES (?, ?)", (new_id, row["host_id"]))
            steps = conn.execute("SELECT * FROM steps WHERE plan_id=? ORDER BY position, id", (plan_id,)).fetchall()
            for step in steps:
                conn.execute(
                    """
                    INSERT INTO steps (plan_id, host_id, position, kind, command, local_path, remote_path, note)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (new_id, step["host_id"], step["position"], step["kind"], step["command"], step["local_path"], step["remote_path"], step["note"]),
                )
            flags = conn.execute("SELECT * FROM line_flags WHERE plan_id=?", (plan_id,)).fetchall()
            for flag in flags:
                conn.execute(
                    "INSERT INTO line_flags (plan_id, host_id, disabled) VALUES (?, ?, ?)",
                    (new_id, flag["host_id"], flag["disabled"]),
                )
        self.send_json({"id": new_id})

    def copy_line(self, payload):
        plan_id = int(payload.get("planId") or 0)
        if not can_plan_for(self.user, plan_id):
            raise ValueError("没有这个画布的权限")
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
            conn.execute("INSERT IGNORE INTO plan_hosts (plan_id, host_id) VALUES (?, ?)", (plan_id, new_host_id))
            steps = conn.execute(
                "SELECT * FROM steps WHERE plan_id=? AND host_id=? ORDER BY position, id",
                (plan_id, host_id),
            ).fetchall()
            for index, step in enumerate(steps, start=1):
                conn.execute(
                    """
                    INSERT INTO steps (plan_id, host_id, position, kind, command, local_path, remote_path, note)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (plan_id, new_host_id, index, step["kind"], step["command"], step["local_path"], step["remote_path"], step["note"]),
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

    def set_all_lines(self, payload):
        plan_id = int(payload.get("planId") or 0)
        disabled = 1 if payload.get("disabled", True) else 0
        if not can_plan_for(self.user, plan_id):
            raise ValueError("没有这个画布的权限")
        with connect() as conn:
            hosts = rows(conn, "SELECT host_id FROM plan_hosts WHERE plan_id=?", (plan_id,))
            if not hosts:
                raise ValueError("这个项目还没有流水线")
            for row in hosts:
                conn.execute(
                    """
                    INSERT INTO line_flags (plan_id, host_id, disabled, force_run) VALUES (?, ?, ?, 0)
                    ON DUPLICATE KEY UPDATE disabled=VALUES(disabled)
                    """,
                    (plan_id, row["host_id"], disabled),
                )
        return self.send_json({"ok": True, "count": len(hosts)})

    def save_line_flag(self, payload):
        plan_id = int(payload.get("planId") or 0)
        if not can_plan_for(self.user, plan_id):
            raise ValueError("没有这个画布的权限")
        host_id = int(payload.get("hostId") or 0)
        if not plan_id or not host_id:
            raise ValueError("请选择项目和主机")
        with connect() as conn:
            current = conn.execute(
                "SELECT disabled, force_run FROM line_flags WHERE plan_id=? AND host_id=?",
                (plan_id, host_id),
            ).fetchone()
            if "disabled" in payload:
                disabled = 1 if payload.get("disabled") else 0
            else:
                disabled = current["disabled"] if current else 0
            if "forceRun" in payload:
                force_run = 1 if payload.get("forceRun") else 0
            else:
                force_run = current["force_run"] if current else 0
            conn.execute(
                """
                INSERT INTO line_flags (plan_id, host_id, disabled, force_run) VALUES (?, ?, ?, ?)
                ON DUPLICATE KEY UPDATE disabled=VALUES(disabled), force_run=VALUES(force_run)
                """,
                (plan_id, host_id, disabled, force_run),
            )
        self.send_json({"ok": True})

    def save_plan(self, payload):
        name = payload.get("name", "").strip()
        steps = payload.get("steps")
        if not name:
            raise ValueError("项目名称不能为空")
        with connect() as conn:
            if payload.get("id"):
                plan_id = int(payload["id"])
                if not can_plan(conn, self.user, plan_id):
                    raise ValueError("没有这个画布的权限")
                conn.execute("UPDATE plans SET name=? WHERE id=?", (name, plan_id))
                if steps is not None:
                    conn.execute("DELETE FROM steps WHERE plan_id=?", (plan_id,))
            else:
                cur = conn.execute(
                    "INSERT INTO plans (name, owner_id, created_at) VALUES (?, ?, ?)",
                    (name, self.user["id"], now()),
                )
                plan_id = cur.lastrowid
                grant_plan(conn, self.user["id"], plan_id)
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
                        (plan_id, host_id, index, kind, str(step.get("command") or ""), str(step.get("localPath") or ""), str(step.get("remotePath") or ""), str(step.get("note") or "")),
                    )
        self.send_json({"id": plan_id})

    def current_user(self):
        return session_user(read_session_token(self.headers.get("Cookie")))

    def require_user(self):
        user = self.current_user()
        if not user:
            self.send_json({"error": "未登录"}, 401)
            return None
        self.user = user
        return user

    def login(self, payload):
        username = str(payload.get("username") or "").strip()
        password = str(payload.get("password") or "")
        with connect() as conn:
            row = conn.execute("SELECT * FROM users WHERE username=?", (username,)).fetchone()
            if not row or not verify_password(password, row["password_hash"]):
                return self.send_json({"error": "用户名或密码错误"}, 401)
            token = secrets.token_urlsafe(32)
            expires = time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(time.time() + 7 * 24 * 3600))
            conn.execute(
                "INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)",
                (token, row["id"], now(), expires),
            )
        return self.send_json(
            {"id": row["id"], "username": row["username"], "isAdmin": bool(row.get("is_admin"))},
            headers=[("Set-Cookie", session_cookie(token, 7 * 24 * 3600))],
        )

    def logout(self):
        token = read_session_token(self.headers.get("Cookie"))
        if token:
            with connect() as conn:
                conn.execute("DELETE FROM sessions WHERE token=?", (token,))
        return self.send_json({"ok": True}, headers=[("Set-Cookie", session_cookie("", 0))])

    def change_password(self, user, payload):
        current = str(payload.get("current") or "")
        password = str(payload.get("password") or "")
        if len(password) < 6:
            raise ValueError("新密码至少 6 位")
        with connect() as conn:
            row = conn.execute("SELECT * FROM users WHERE id=?", (user["id"],)).fetchone()
            if not row or not verify_password(current, row["password_hash"]):
                return self.send_json({"error": "当前密码不正确"}, 400)
            conn.execute("UPDATE users SET password_hash=? WHERE id=?", (hash_password(password), user["id"]))
            conn.execute("DELETE FROM sessions WHERE user_id=?", (user["id"],))
        return self.send_json({"ok": True}, headers=[("Set-Cookie", session_cookie("", 0))])

    def list_users(self):
        if not self.user.get("is_admin"):
            return self.send_json({"error": "只有管理员可以管理用户"}, 403)
        with connect() as conn:
            users = rows(conn, "SELECT id, username, is_admin, created_at FROM users ORDER BY id")
            grants = rows(conn, "SELECT user_id, plan_id FROM plan_access")
            plans = rows(conn, "SELECT id, name FROM plans ORDER BY id DESC")
        by_user = {}
        for grant in grants:
            by_user.setdefault(grant["user_id"], []).append(grant["plan_id"])
        for user in users:
            user["isAdmin"] = bool(user.pop("is_admin"))
            user["planIds"] = by_user.get(user["id"], [])
        return self.send_json({"users": users, "plans": plans})

    def create_user(self, payload):
        if not self.user.get("is_admin"):
            return self.send_json({"error": "只有管理员可以管理用户"}, 403)
        username = str(payload.get("username") or "").strip()
        password = str(payload.get("password") or "")
        plan_ids = [int(x) for x in payload.get("planIds") or []]
        if not username:
            raise ValueError("请填写用户名")
        if len(password) < 6:
            raise ValueError("密码至少 6 位")
        with connect() as conn:
            if conn.execute("SELECT id FROM users WHERE username=?", (username,)).fetchone():
                raise ValueError("用户名已存在")
            cur = conn.execute(
                "INSERT INTO users (username, password_hash, created_at, is_admin) VALUES (?, ?, ?, 0)",
                (username, hash_password(password), now()),
            )
            user_id = cur.lastrowid
            for plan_id in plan_ids:
                if conn.execute("SELECT id FROM plans WHERE id=?", (plan_id,)).fetchone():
                    grant_plan(conn, user_id, plan_id)
        return self.send_json({"id": user_id})

    def save_grants(self, payload):
        if not self.user.get("is_admin"):
            return self.send_json({"error": "只有管理员可以管理用户"}, 403)
        user_id = int(payload.get("userId") or 0)
        plan_ids = [int(x) for x in payload.get("planIds") or []]
        with connect() as conn:
            user = conn.execute("SELECT id, is_admin FROM users WHERE id=?", (user_id,)).fetchone()
            if not user:
                raise ValueError("用户不存在")
            if user["is_admin"]:
                raise ValueError("管理员可以打开全部画布，不用单独授权")
            conn.execute("DELETE FROM plan_access WHERE user_id=?", (user_id,))
            for plan_id in plan_ids:
                if conn.execute("SELECT id FROM plans WHERE id=?", (plan_id,)).fetchone():
                    grant_plan(conn, user_id, plan_id)
        return self.send_json({"ok": True})

    def delete_user(self, user_id):
        if not self.user.get("is_admin"):
            return self.send_json({"error": "只有管理员可以管理用户"}, 403)
        if user_id == self.user["id"]:
            raise ValueError("不能删除当前登录用户")
        with connect() as conn:
            user = conn.execute("SELECT id, is_admin FROM users WHERE id=?", (user_id,)).fetchone()
            if not user:
                raise ValueError("用户不存在")
            if user["is_admin"]:
                admins = conn.execute("SELECT COUNT(*) AS n FROM users WHERE is_admin=1").fetchone()["n"]
                if admins <= 1:
                    raise ValueError("至少保留一个管理员")
            conn.execute("DELETE FROM sessions WHERE user_id=?", (user_id,))
            conn.execute("DELETE FROM plan_access WHERE user_id=?", (user_id,))
            conn.execute("UPDATE plans SET owner_id=NULL WHERE owner_id=?", (user_id,))
            conn.execute("DELETE FROM users WHERE id=?", (user_id,))
        return self.send_json({"ok": True})

    def do_DELETE(self):
        if not self.require_user():
            return
        path = urlparse(self.path).path
        parts = [p for p in path.split("/") if p]
        try:
            if len(parts) == 5 and parts[0] == "api" and parts[1] == "plans" and parts[3] == "hosts":
                plan_id = int(parts[2])
                host_id = int(parts[4])
                if not can_plan_for(self.user, plan_id):
                    return self.send_json({"error": "没有这个画布的权限"}, 403)
                with connect() as conn:
                    conn.execute("DELETE FROM steps WHERE plan_id=? AND host_id=?", (plan_id, host_id))
                    conn.execute("DELETE FROM line_flags WHERE plan_id=? AND host_id=?", (plan_id, host_id))
                    conn.execute("DELETE FROM plan_hosts WHERE plan_id=? AND host_id=?", (plan_id, host_id))
                return self.send_json({"ok": True})
            if len(parts) == 3 and parts[0] == "api" and parts[1] == "hosts":
                if not self.user.get("is_admin"):
                    return self.send_json({"error": "只有管理员可以删除主机"}, 403)
                host_id = int(parts[2])
                with connect() as conn:
                    conn.execute("DELETE FROM steps WHERE host_id=?", (host_id,))
                    conn.execute("DELETE FROM line_flags WHERE host_id=?", (host_id,))
                    conn.execute("DELETE FROM plan_hosts WHERE host_id=?", (host_id,))
                    conn.execute("DELETE FROM hosts WHERE id=?", (host_id,))
                return self.send_json({"ok": True})
            if len(parts) == 3 and parts[0] == "api" and parts[1] == "users":
                return self.delete_user(int(parts[2]))
            if len(parts) == 3 and parts[0] == "api" and parts[1] == "plans":
                plan_id = int(parts[2])
                with connect() as conn:
                    plan = conn.execute("SELECT owner_id FROM plans WHERE id=?", (plan_id,)).fetchone()
                    if not plan:
                        raise ValueError("项目不存在")
                    if not self.user.get("is_admin") and plan["owner_id"] != self.user["id"]:
                        return self.send_json({"error": "只能删除自己创建的画布"}, 403)
                    conn.execute("DELETE FROM steps WHERE plan_id=?", (plan_id,))
                    conn.execute("DELETE FROM line_flags WHERE plan_id=?", (plan_id,))
                    conn.execute("DELETE FROM plan_access WHERE plan_id=?", (plan_id,))
                    conn.execute("DELETE FROM plans WHERE id=?", (plan_id,))
                return self.send_json({"ok": True})
            if len(parts) == 3 and parts[0] == "api" and parts[1] == "steps":
                with connect() as conn:
                    step = conn.execute("SELECT plan_id FROM steps WHERE id=?", (int(parts[2]),)).fetchone()
                    if not step or not can_plan(conn, self.user, step["plan_id"]):
                        return self.send_json({"error": "没有这个画布的权限"}, 403)
                    conn.execute("DELETE FROM steps WHERE id=?", (int(parts[2]),))
                return self.send_json({"ok": True})
        except ValueError as exc:
            return self.send_json({"error": str(exc)}, 400)
        self.send_json({"error": "未找到"}, 404)


def main():
    parser = argparse.ArgumentParser(description="服务部署分发系统")
    parser.add_argument("--host", default="0.0.0.0")
    parser.add_argument("--port", type=int, default=8787)
    args = parser.parse_args()
    init_db()
    recover_interrupted_runs()
    server = ThreadingHTTPServer((args.host, args.port), Handler)
    print(f"部署分发系统已启动：http://{args.host}:{args.port}")
    server.serve_forever()


if __name__ == "__main__":
    main()
