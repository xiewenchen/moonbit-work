#!/usr/bin/env python3
"""极简 Alertmanager webhook 接收端 —— 用于**证明告警真的被投递出去**。

只配告警规则不接 Alertmanager，告警就只停在 Prometheus UI 里没人看。
本接收端把收到的告警打印并落盘到 deploy/alert-receiver.log，
从而给出「触发 → 路由 → 抑制 → 投递」的端到端证据。

用法:
    python deploy/alert-receiver.py           # 监听 0.0.0.0:9099
"""
import json
import sys
import time
from http.server import BaseHTTPRequestHandler, HTTPServer

LOG = "deploy/alert-receiver.log"
PORT = 9099


class Handler(BaseHTTPRequestHandler):
    def do_POST(self):
        n = int(self.headers.get("Content-Length", 0))
        raw = self.rfile.read(n)
        try:
            d = json.loads(raw)
        except Exception:
            self.send_response(400)
            self.end_headers()
            return

        status = d.get("status", "?")
        alerts = d.get("alerts", [])
        common = d.get("commonLabels", {})
        ts = time.strftime("%H:%M:%S")
        line = f"[{ts}] {status.upper():9s} 共 {len(alerts)} 条  group={common.get('alertname','?')}"
        print(line, flush=True)
        for a in alerts:
            lbl = a.get("labels", {})
            ann = a.get("annotations", {})
            print(
                f"           - {lbl.get('alertname')}  "
                f"severity={lbl.get('severity')}  instance={lbl.get('instance','-')}",
                flush=True,
            )
            if ann.get("summary"):
                print(f"             {ann['summary']}", flush=True)
        with open(LOG, "a", encoding="utf-8") as f:
            f.write(line + "\n")
            for a in alerts:
                f.write("    " + json.dumps(a, ensure_ascii=False)[:400] + "\n")

        self.send_response(200)
        self.end_headers()
        self.wfile.write(b"ok")

    def log_message(self, *args):
        pass  # 静音默认访问日志，只保留告警


if __name__ == "__main__":
    print(f"告警接收端监听 0.0.0.0:{PORT}，落盘到 {LOG}", flush=True)
    try:
        HTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
    except KeyboardInterrupt:
        sys.exit(0)
