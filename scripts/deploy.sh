#!/bin/bash
set -u

BASE="http://127.0.0.1"
USER="proxydddddd"
PASS="KDddddddddddd"
PROJECT="proxy服务同步发版"
COOKIE="/tmp/deploy.cookies"

curl -sS --max-time 15 -c "$COOKIE" -X POST "$BASE/api/login" \
  -H "Content-Type: application/json" \
  -d "{\"username\":\"$USER\",\"password\":\"$PASS\"}" \
  | python3 -c 'import json,sys; d=json.load(sys.stdin); sys.exit(0 if "id" in d else (print(d.get("error","登录失败")) or 1))'

curl -sS --max-time 20 -b "$COOKIE" "$BASE/api/state" -o /tmp/deploy-state.json

python3 - "$PROJECT" <<'PY'
import json, sys
name = sys.argv[1]
state = json.load(open("/tmp/deploy-state.json", encoding="utf-8"))
plans = [p for p in state.get("plans") or [] if p.get("name") == name]
if len(plans) != 1:
    sys.exit("找不到唯一项目：%s（匹配到 %d 个）" % (name, len(plans)))
plan = plans[0]
hosts = {h["id"]: h.get("name") or str(h["id"]) for h in state.get("hosts") or []}
disabled = set(plan.get("disabledHostIds") or [])
rows = []
for hid in plan.get("hostIds") or []:
    notes = []
    for step in plan.get("steps") or []:
        if step.get("host_id") == hid and step.get("disabled"):
            text = (step.get("command") or "").strip().splitlines()
            notes.append(text[0] if text else "未命名步骤")
    rows.append({"id": hid, "name": hosts.get(hid, str(hid)), "disabled": hid in disabled, "note": "；".join(notes)})
json.dump({"planId": plan["id"], "rows": rows}, open("/tmp/deploy-plan.json", "w", encoding="utf-8"), ensure_ascii=False)
PY

python3 - <<'PY'
import json
plan = json.load(open("/tmp/deploy-plan.json", encoding="utf-8"))
for row in plan["rows"]:
    if row["disabled"]:
        print("%-28s %-18s %s" % (row["name"], "已禁用", "不执行更新"))
PY

python3 - <<'PY' | while read -r HOST_ID HOST_NAME; do
import json
plan = json.load(open("/tmp/deploy-plan.json", encoding="utf-8"))
for row in plan["rows"]:
    if not row["disabled"]:
        print(row["id"], row["name"])
PY
  PLAN_ID=$(python3 -c 'import json; print(json.load(open("/tmp/deploy-plan.json",encoding="utf-8"))["planId"])')
  NOTE=$(python3 -c 'import json,sys; hid=int(sys.argv[1]); rows=json.load(open("/tmp/deploy-plan.json",encoding="utf-8"))["rows"]; print(next(r["note"] for r in rows if r["id"]==hid))' "$HOST_ID")
  printf "%-28s %-18s" "$HOST_NAME" "开始执行"
  if ! curl -sS --max-time 20 -b "$COOKIE" -X POST "$BASE/api/line-flags" \
      -H "Content-Type: application/json" \
      -d "{\"planId\":$PLAN_ID,\"hostId\":$HOST_ID,\"forceRun\":true}" \
      -o /tmp/deploy-refresh.json; then
    printf "\r%-28s %-18s %s\n" "$HOST_NAME" "开始执行" "执行失败    刷新这条线超时"
    continue
  fi
  REFRESH_ERR=$(python3 -c 'import json; d=json.load(open("/tmp/deploy-refresh.json",encoding="utf-8")); print(d.get("error") or "")')
  if [ -n "$REFRESH_ERR" ]; then
    printf "\r%-28s %-18s %s\n" "$HOST_NAME" "开始执行" "执行失败    刷新这条线失败：$REFRESH_ERR"
    continue
  fi
  if ! curl -sS --max-time 20 -b "$COOKIE" -X POST "$BASE/api/runs" \
      -H "Content-Type: application/json" \
      -d "{\"planId\":$PLAN_ID,\"hostIds\":[$HOST_ID]}" \
      -o /tmp/deploy-start.json; then
    printf "\r%-28s %-18s %s\n" "$HOST_NAME" "开始执行" "执行失败    启动请求超时，服务里还有任务卡住"
    continue
  fi
  RUN_ID=$(python3 -c 'import json
d=json.load(open("/tmp/deploy-start.json",encoding="utf-8"))
open("/tmp/deploy-start-error.txt","w",encoding="utf-8").write(d.get("error") or "")
print(d.get("id") or "")')
  if [ -z "$RUN_ID" ]; then
    ERR=$(cat /tmp/deploy-start-error.txt)
    printf "\r%-28s %-18s %s\n" "$HOST_NAME" "开始执行" "执行失败    ${ERR:-启动失败}"
    continue
  fi
  STATUS="running"
  for i in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20 21 22 23 24 25 26 27 28 29 30; do
    curl -sS --max-time 10 -b "$COOKIE" "$BASE/api/runs/$RUN_ID" -o /tmp/deploy-result.json || true
    STATUS=$(python3 -c 'import json; print(json.load(open("/tmp/deploy-result.json",encoding="utf-8")).get("status",""))')
    [ "$STATUS" != "running" ] && [ "$STATUS" != "interrupted" ] && break
    sleep 2
  done
  RESULT=$(NOTE="$NOTE" python3 - <<'PY'
import json, os
run = json.load(open("/tmp/deploy-result.json", encoding="utf-8"))
note = os.environ.get("NOTE") or ""
status = run.get("status")
steps = run.get("steps") or []
if status == "success":
    text = "执行成功"
    if note:
        text += "    备注：%s 已禁用" % note
    print(text)
elif steps and all(s.get("status") == "pending" for s in steps):
    print("执行失败    任务已创建，但第一步一直没有开始")
elif status in ("running", "interrupted"):
    current = next((s.get("preview") for s in steps if s.get("status") == "running"), "")
    print("执行失败    等待超时" + (("：" + current) if current else ""))
else:
    failed = next((s for s in steps if s.get("status") == "failed"), None)
    if not failed:
        print("执行失败    " + (run.get("message") or "执行失败"))
    else:
        lines = [x for x in (failed.get("output") or "").splitlines() if x.strip() and "已停止后续步骤" not in x]
        reason = lines[-1] if lines else (failed.get("preview") or "执行失败")
        print("执行失败    %s：%s" % (failed.get("preview") or "步骤", reason))
PY
)
  printf "\r%-28s %-18s %s\n" "$HOST_NAME" "开始执行" "$RESULT"
done
