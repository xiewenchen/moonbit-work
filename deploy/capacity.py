#!/usr/bin/env python3
"""单实例容量标定：逐级加压，找出吞吐拐点与延迟恶化点。

用途：为「实例数」与「全局并发上限」提供数据依据，
      而不是凭感觉设 MBP_RATE_LIMIT。

用法: python deploy/capacity.py [base_url] [每档请求数]
默认 http://127.0.0.1:8101（单实例，绕过 nginx）
"""
import json
import sys
import threading
import time
import urllib.error
import urllib.request

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8101"
PER_LEVEL = int(sys.argv[2]) if len(sys.argv) > 2 else 2000
LEVELS = [1, 8, 32, 64, 128]

lock = threading.Lock()
ok = 0
fail = 0
lat = []


def worker(ids):
    global ok, fail
    for _ in ids:
        try:
            t0 = time.perf_counter()
            with urllib.request.urlopen(BASE + "/api/tags", timeout=30) as r:
                r.read()
            dt = (time.perf_counter() - t0) * 1000
            with lock:
                ok += 1
                lat.append(dt)
        except Exception:
            with lock:
                fail += 1


def pct(a, p):
    if not a:
        return 0.0
    return a[min(len(a) - 1, int(len(a) * p / 100))]


print("=" * 78)
print(f"单实例容量标定 @ {BASE}    每档 {PER_LEVEL} 请求")
print("=" * 78)
print(f"{'并发':>6} {'QPS':>9} {'成功':>7} {'失败':>6} {'p50':>8} {'p95':>8} {'p99':>8} {'max':>9}")
print("-" * 78)

results = []
for conc in LEVELS:
    with lock:
        ok = 0
        fail = 0
        lat.clear()
    chunks = [[] for _ in range(conc)]
    for i in range(PER_LEVEL):
        chunks[i % conc].append(i)
    threads = [threading.Thread(target=worker, args=(c,)) for c in chunks]
    t0 = time.perf_counter()
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    el = time.perf_counter() - t0
    with lock:
        a = sorted(lat)
        o, f = ok, fail
    qps = o / el if el else 0
    row = (conc, qps, o, f, pct(a, 50), pct(a, 95), pct(a, 99), max(a) if a else 0)
    results.append(row)
    print(f"{conc:>6} {qps:>9.0f} {o:>7} {f:>6} {row[4]:>8.1f} {row[5]:>8.1f} {row[6]:>8.1f} {row[7]:>9.1f}")

print("-" * 78)
# 找拐点：QPS 相对上一档增长 < 15% 视为饱和
peak = max(results, key=lambda r: r[1])
print(f"\n峰值吞吐: {peak[1]:.0f} req/s @ 并发 {peak[0]}")
for i in range(1, len(results)):
    prev, cur = results[i - 1], results[i]
    growth = (cur[1] - prev[1]) / prev[1] if prev[1] else 0
    if growth < 0.15:
        print(f"饱和点: 并发 {prev[0]} → {cur[0]} 时 QPS 仅增长 {growth*100:.0f}%，"
              f"而 p95 从 {prev[5]:.1f}ms 变为 {cur[5]:.1f}ms")
        print(f"→ 建议把单实例的并发处理上限设在 {prev[0]} 附近")
        break
