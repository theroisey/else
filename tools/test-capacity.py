#!/usr/bin/env python3
"""Bounded 500-client/100-user rehearsal against the exact image, never live data."""
import argparse
from concurrent.futures import ThreadPoolExecutor
import http.client
import json
import os
from pathlib import Path
import socket
import subprocess
import tempfile
import threading
import time
import uuid

ROOT = Path(__file__).resolve().parent.parent
ADMIN = "44444444-4444-4444-8444-444444444444"
CLIENT = "00000001-0000-4000-8000-000000000001"
CONNECTION = "00000008-0000-4000-8000-000000000001"


def docker(*args, **kwargs):
    return subprocess.run([os.environ.get("DOCKER", "docker"), *args], check=True, **kwargs)


def sequence(count):
    return f"(WITH RECURSIVE seq(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM seq WHERE i<{count}) SELECT i FROM seq)"


def identifier(prefix, value="i"):
    return f"('{prefix}-0000-4000-8000-'||printf('%012d',{value}))"


def fixtures():
    c = identifier("00000001", "((i-1)%500)+1")
    actor = "'" + ADMIN + "'"
    sql = (ROOT / "frontend/e2e/fixtures.sql").read_text()
    sql += f"""
INSERT INTO client_scopes SELECT {identifier('00000001')} FROM {sequence(500)};
INSERT INTO clients(id,name,created_at,updated_at) SELECT {identifier('00000001')},'Synthetic capacity client '||i,utc_now(),utc_now() FROM {sequence(500)};
INSERT INTO users(id,email,display_name,password_hash,status,created_at,updated_at) SELECT {identifier('00000002')},'capacity.'||i||'@example.com','Synthetic capacity user',password_hash,'active',utc_now(),utc_now() FROM {sequence(100)},users WHERE users.id={actor};
INSERT INTO user_roles(id,user_id,role_id,scope_kind,assigned_at) SELECT new_id(),id,'00000000-0000-4000-8000-000000000001','global',utc_now() FROM users WHERE id LIKE '00000002-%';
INSERT INTO tasks(id,client_id,created_by,title,status,priority,due_at,created_at,updated_at) SELECT {identifier('00000003')},{c},{actor},'Synthetic capacity task','todo','medium',utc_shift(-i),utc_now(),utc_now() FROM {sequence(50000)};
INSERT INTO reminders(id,client_id,created_by,owner_id,title,status,scheduled_at,scheduled_local,timezone,utc_offset_seconds,revision,created_at,updated_at) SELECT {identifier('00000004')},{c},{actor},{actor},'Synthetic capacity reminder','pending','2020-01-01T00:00:00.000000Z','2020-01-01T00:00:00','Etc/UTC',0,1,utc_now(),utc_now() FROM {sequence(20000)};
INSERT INTO collections(id,client_id,created_by,description,amount_minor,currency,currency_exponent,due_date,revision,created_at,updated_at) SELECT {identifier('00000005')},{c},{actor},'Synthetic capacity invoice',9007199254740993,'EUR',2,'2020-01-01',1,utc_now(),utc_now() FROM {sequence(10000)};
INSERT INTO pricing_sheets(id,client_id,currency,currency_exponent,revision) SELECT {identifier('00000006')},{c},'EUR',2,1 FROM {sequence(5000)};
INSERT INTO pricing_versions(id,sheet_id,client_id,currency,revision,title,note,effective_from,created_by,created_at,base_minor,discount_minor,net_minor,tax_minor,total_minor) SELECT id,id,client_id,currency,1,'Synthetic capacity agreement','','2020-01-01',{actor},utc_now(),100,0,100,0,100 FROM pricing_sheets;
INSERT INTO pricing_lines(version_id,position,description,kind,frequency,quantity_micros,unit_price_minor,discount_bps,tax_bps,base_minor,discount_minor,net_minor,tax_minor,total_minor) SELECT id,1,'Synthetic service','one_time','none',1000000,100,0,0,100,0,100,0,100 FROM pricing_versions;
INSERT INTO plans(id,client_id,created_by,title,status,revision,created_at,updated_at) SELECT {identifier('00000007')},{c},{actor},'Synthetic capacity plan','active',1,utc_now(),utc_now() FROM {sequence(1000)};
INSERT INTO audit_events(id,occurred_at,schema_version,actor_kind,actor_user_id,event_name,resource_kind,resource_id,client_id,request_id,before_state,after_state,metadata) SELECT new_id(),utc_shift(-i),1,'user',{actor},'task.created','task',{identifier('00000003')},{c},'AAAAAAAAAAAAAAAAAAAAAAAAAA','{{}}','{{"exists":true,"revision":1,"task_status":"todo"}}','{{"source":"http"}}' FROM {sequence(20000)};
INSERT INTO integration_connections(id,client_id,provider,provider_account_id,state,revision,generation,created_at,updated_at) SELECT {identifier('00000008')},{c},'ga4',CAST(9700000+i AS TEXT),'connected',1,1,utc_now(),utc_now() FROM {sequence(1500)};
INSERT INTO analytics_sync_jobs(id,client_id,connection_id,requested_by,provider,since,until,connection_revision,generation,credential_revision,state,attempts,revision,created_at,updated_at,finished_at) SELECT new_id(),client_id,id,{actor},provider,'2026-10-01','2026-10-03',1,1,1,'succeeded',1,1,utc_now(),utc_now(),utc_now() FROM integration_connections;
"""
    metrics = ["activeUsers", "sessions", "screenPageViews", "keyEvents"]
    base = {"client_id": CLIENT, "connection_id": CONNECTION, "api_version": "v1beta", "timezone": "Europe/Istanbul", "since": "2026-10-01", "until": "2026-10-03", "metrics": metrics}
    dimensions = {"summary": [], "daily": ["date"], "acquisition": ["date", "sessionDefaultChannelGroup"], "devices": ["date", "deviceCategory"], "landing": ["landingPage"]}
    workspace = {key: {**base, "dimensions": value, "rows": []} for key, value in dimensions.items()}
    workspace["definitions"] = [{"name": key, "type": "TYPE_INTEGER", "display_name": key, "description": "Synthetic capacity metric definition."} for key in metrics]
    raw = json.dumps(workspace).replace("'", "''")
    updates = ",".join(f"'$.{key}.client_id',client_id,'$.{key}.connection_id',id" for key in dimensions)
    value = f"json_set('{raw}',{updates})"
    sql += f"INSERT INTO analytics_snapshots(id,client_id,connection_id,generation,provider,since,until,revision,workspace,workspace_sha256,synced_at) SELECT new_id(),client_id,id,1,provider,'2026-10-01','2026-10-03',1,{value},sha256({value}),utc_now() FROM integration_connections;\n"
    sql += "SELECT count(*) FROM tasks; SELECT count(*) FROM reminders; SELECT count(*) FROM collections; SELECT count(*) FROM pricing_sheets; SELECT count(*) FROM analytics_snapshots;\n"
    return sql


def percentile(values, fraction):
    ordered = sorted(values)
    return round(ordered[min(len(ordered) - 1, int(len(ordered) * fraction))] * 1000, 2)


def run(args):
    name = "else-capacity-test-" + uuid.uuid4().hex
    with tempfile.TemporaryDirectory(prefix="else-browser-capacity-") as temporary:
        directory = Path(temporary)
        directory.chmod(0o700)
        (directory / ".fixture-control").write_bytes(b"disposable-synthetic-browser-fixture")
        environment = {**os.environ, "AUTH_TEST_DIRECTORY": temporary}
        seeded = subprocess.run([str(args.fixture_binary.resolve())], input=fixtures(), text=True, capture_output=True, env=environment, check=True, timeout=60)
        assert seeded.stdout.strip().splitlines() == ["50000", "20000", "10000", "5000", "1500"]
        with socket.socket() as selected:
            selected.bind(("127.0.0.1", 0))
            port = selected.getsockname()[1]
        origin = f"http://127.0.0.1:{port}"
        created = False
        try:
            docker("run", "--detach", "--name", name, "--read-only", "--cap-drop=ALL", "--security-opt=no-new-privileges",
                   "--memory=256m", "--cpus=2", "--user", f"{os.getuid()}:{os.getgid()}", "--publish", f"127.0.0.1:{port}:8080",
                   "--mount", f"type=bind,src={directory},dst=/testdata", "-e", "DATABASE_PATH=/testdata/else.sqlite3",
                   "-e", "AUTH_PUBLIC_ORIGIN=" + origin, "-e", "AUTH_COOKIE_SECURE=false", "-e", "REDIS_URL=redis://127.0.0.1:1/0", args.image, stdout=subprocess.DEVNULL)
            created = True
            deadline = time.monotonic() + 30
            while True:
                try:
                    connection = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
                    connection.request("GET", "/ready")
                    response = connection.getresponse()
                    response.read()
                    connection.close()
                    if response.status == 200:
                        break
                except (OSError, http.client.HTTPException):
                    pass
                assert time.monotonic() < deadline, "capacity runtime readiness timed out"
                time.sleep(0.05)
            sessions = []
            for user in range(1, 101):
                connection = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
                body = json.dumps({"email": f"capacity.{user}@example.com", "password": "clearly synthetic browser password"})
                connection.request("POST", "/api/v1/auth/login", body, {"Content-Type": "application/json", "Origin": origin})
                response = connection.getresponse()
                assert response.status == 200, "capacity synthetic login failed"
                cookies = [value.split(";", 1)[0] for key, value in response.getheaders() if key.lower() == "set-cookie"]
                response.read()
                connection.close()
                sessions.append(("; ".join(cookies), next(value.split("=", 1)[1] for value in cookies if value.startswith("else_csrf="))))
            barrier = threading.Barrier(100, timeout=15)
            root = "/api/v1/clients/" + CLIENT
            paths = ["/api/v1/clients?limit=25", root + "/overview", root + "/tasks?limit=25", root + "/reminders?limit=25",
                     root + "/billing?limit=25", root + "/pricing?limit=25", root + "/activity?limit=25", root + "/audit-logs?limit=25",
                     root + "/analytics/" + CONNECTION + "?since=2026-10-01&until=2026-10-03", root + "/plans?limit=25"]

            def user_work(user):
                connection = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
                cookie, csrf = sessions[user]
                timings, writes = [], []
                barrier.wait()
                for request in range(30):
                    write = request == 15
                    start = time.monotonic()
                    path = root + "/tasks" if write else paths[(request + user) % len(paths)]
                    payload = json.dumps({"title": "Synthetic concurrent write"}) if write else None
                    headers = {"Cookie": cookie}
                    if write:
                        headers.update({"Origin": origin, "Content-Type": "application/json", "X-CSRF-Token": csrf})
                    connection.request("POST" if write else "GET", path, payload, headers)
                    response = connection.getresponse()
                    body = json.loads(response.read())
                    assert response.status == (201 if write else 200), f"capacity {path}: HTTP {response.status}"
                    elapsed = time.monotonic() - start
                    (writes if write else timings).append(elapsed)
                    if not write and path.endswith("/overview"):
                        assert body["data"]["finance"]["currencies"][0]["outstanding_minor"] == str(20 * 9007199254740993)
                    if not write and "/analytics/" in path:
                        assert body["status"]["state"] == "succeeded" and body["data"]["summary"]["rows"] == []
                connection.close()
                return timings, writes

            start = time.monotonic()
            with ThreadPoolExecutor(max_workers=100) as pool:
                observations = list(pool.map(user_work, range(100)))
            elapsed = time.monotonic() - start
            reads = [value for group, _ in observations for value in group]
            writes = [value for _, group in observations for value in group]
            assert percentile(reads, .95) < 2000, "dashboard/read P95 exceeds two seconds"
            assert percentile(writes, .95) < 2000, "CRUD P95 exceeds two seconds"
            assert percentile(reads + writes, .99) < 3000, "mixed P99 exceeds three seconds"
            final = subprocess.run([str(args.fixture_binary.resolve())], input="SELECT count(*) FROM tasks; SELECT count(*) FROM audit_events WHERE event_name='task.created';", text=True, capture_output=True, env=environment, check=True)
            assert final.stdout.strip().splitlines() == ["50100", "20100"], "concurrent writes/audits did not reconcile"
            stats = json.loads(docker("stats", "--no-stream", "--format", "{{json .}}", name, capture_output=True, text=True).stdout)
            evidence = {"clients": 500, "concurrent_users": 100, "requests": 3000, "writes": 100, "cpu_limit": 2, "memory_limit_mib": 256,
                        "image_id": json.loads(docker("image", "inspect", args.image, capture_output=True, text=True).stdout)[0]["Id"],
                        "duration_seconds": round(elapsed, 2), "read_p95_ms": percentile(reads, .95), "write_p95_ms": percentile(writes, .95),
                        "mixed_p99_ms": percentile(reads + writes, .99), "observed_memory": stats["MemUsage"], "cache": "unavailable; SQLite fallback verified"}
            print(json.dumps(evidence, sort_keys=True))
            if args.evidence:
                args.evidence.parent.mkdir(parents=True, exist_ok=True)
                args.evidence.write_text(json.dumps(evidence, sort_keys=True, indent=2) + "\n")
            docker("kill", "--signal=TERM", name, stdout=subprocess.DEVNULL)
            assert docker("wait", name, capture_output=True, text=True, timeout=15).stdout.strip() == "0"
        finally:
            if created:
                docker("rm", "--force", name, stdout=subprocess.DEVNULL)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--image", default="else-application:ci")
    parser.add_argument("--fixture-binary", type=Path, default=ROOT / "target/debug/examples/browser-fixture")
    parser.add_argument("--evidence", type=Path)
    run(parser.parse_args())
