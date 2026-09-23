#!/usr/bin/env python3
"""Conduit 部署压测：经 nginx 打混合读写请求，统计吞吐/延迟/失败率。

用法：
    python deploy/loadtest.py [base_url] [总请求数] [并发数]
默认 http://127.0.0.1:8090（nginx）, 6000, 48
"""
import json
import random
import sys
import threading
import time
import urllib.error
import urllib.request

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8090"
TOTAL = int(sys.argv[2]) if len(sys.argv) > 2 else 6000
CONC = int(sys.argv[3]) if len(sys.argv) > 3 else 48

ok = 0
fail = 0
lat = []
lock = threading.Lock()
stop = threading.Event()


def one_request(i):
    """读多写少的混合负载。"""
    r = random.random()
    try:
        if r < 0.55:
            url, method, data = BASE + "/api/tags", "GET", None
        elif r < 0.80:
            url, method, data = BASE + "/api/articles?limit=5", "GET", None
        elif r < 0.90:
            url, method, data = BASE + "/health", "GET", None
        elif r < 0.95:
            # 匿名读 profile（不存在的用户 → 404，也是有效响应）
            url, method, data = BASE + "/api/profiles/nobody", "GET", None
        else:
            # 登录（会走 bcrypt 校验，制造 CPU 压力）
            url = BASE + "/api/users/login"
            method = "POST"
            data = json.dumps(
                {"user": {"email": "nonexistent@example.com", "password": "password123"}}
            ).encode()
        req = urllib.request.Request(
            url, data=data, method=method,
            headers={"Content-Type": "application/json"} if data else {},
        )
        t0 = time.perf_counter()
        with urllib.request.urlopen(req, timeout=20) as resp:
            resp.read()
            code = resp.status
        dt = (time.perf_counter() - t0) * 1000
        return code, dt
    except urllib.error.HTTPError as e:
        e.read()
        return e.code, 0.0  # 4xx 也算服务正常响应
    except Exception:
        return None, 0.0


def worker(ids):
    global ok, fail
    for i in ids:
        if stop.is_set():
            return
        code, dt = one_request(i)
        with lock:
            if code is None:
                fail += 1
            else:
                ok += 1
                if dt:
                    lat.append(dt)


def main():
    print("=" * 74)
    print(f"Conduit 压测 @ {BASE}   总请求 {TOTAL}   并发 {CONC}")
    print("=" * 74)
    chunks = [[] for _ in range(CONC)]
    for i in range(TOTAL):
        chunks[i % CONC].append(i)

    threads = [threading.Thread(target=worker, args=(c,)) for c in chunks]
    t0 = time.perf_counter()
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    elapsed = time.perf_counter() - t0

    lat.sort()

    def pct(p):
        if not lat:
            return 0.0
        idx = min(len(lat) - 1, int(len(lat) * p / 100))
        return lat[idx]

    qps = ok / elapsed if elapsed > 0 else 0
    print(f"\n耗时       {elapsed:.2f}s")
    print(f"成功/失败  {ok} / {fail}")
    print(f"吞吐       {qps:.0f} req/s")
    print(f"延迟(ms)   p50={pct(50):.1f}  p95={pct(95):.1f}  p99={pct(99):.1f}  max={max(lat) if lat else 0:.1f}")
    print("=" * 74)
    return 1 if fail else 0


if __name__ == "__main__":
    sys.exit(main())
