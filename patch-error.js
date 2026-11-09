const fs = require("fs");
const p = "D:/tmp/deploy-system/app.py";
let c = fs.readFileSync(p, "utf8");
if (!c.includes("输出中包含 error")) {
  c = c.replace(
`                output_len = 0
                assert proc.stdout is not None
                for line in proc.stdout:
                    output_len += len(line)
                    if output_len <= 200_000:
                        append_output(item["id"], line)
`,
`                output_len = 0
                captured = []
                assert proc.stdout is not None
                for line in proc.stdout:
                    output_len += len(line)
                    captured.append(line)
                    if output_len <= 200_000:
                        append_output(item["id"], line)
`
  );
  c = c.replace(
`                code = proc.wait()
                _current["proc"] = None
`,
`                code = proc.wait()
                _current["proc"] = None
                if code == 0 and "error" in "".join(captured).lower():
                    code = 1
                    append_output(item["id"], "\\n输出中包含 error，已标红并停止后续步骤\\n")
`
  );
  c = c.replace(
`    _current["proc"] = proc
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
`,
`    _current["proc"] = proc
    output_len = 0
    captured = []
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
                code = int(stripped.rsplit(" ", 1)[-1])
            except ValueError:
                code = 1
            if code == 0 and "error" in "".join(captured).lower():
                append_output(item_id, "\\n输出中包含 error，已标红并停止后续步骤\\n")
                return 1
            return code
        captured.append(line)
        output_len += len(line)
        if output_len <= 200_000:
            append_output(item_id, line)
`
  );
  fs.writeFileSync(p, c);
}
fs.copyFileSync(p, "C:/Users/jiuzhou/Documents/Codex/2026-10-29/new-chat-3/deploy-system/app.py");
console.log("ok", c.includes("输出中包含 error"));
