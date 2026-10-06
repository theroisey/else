"""Use the unshipped static helper only inside owned synthetic containers."""
import json
import os
from pathlib import Path
import subprocess

ROOT = Path(__file__).resolve().parents[1]
HELPER = "/var/lib/roisey-else/.runtime-fixture"


def docker(*arguments, **options):
    return subprocess.run([os.environ.get("DOCKER", "docker"), *arguments], check=True, **options)


def install(container):
    binary = ROOT / "build/runtime-fixture"
    binary.chmod(0o755)
    docker("cp", str(binary), container + ":" + HELPER, stdout=subprocess.DEVNULL)


def action(container, operation):
    result = subprocess.run([os.environ.get("DOCKER", "docker"), "exec", container, HELPER, operation], capture_output=True, text=True)
    if result.returncode != 0:
        raise AssertionError("Synthetic runtime helper failed: " + result.stderr.strip())
    return json.loads(result.stdout)


def inspect(container):
    result = action(container, "inspect")
    expected = {
        "bind": "127.0.0.1", "port": "6379", "save": "", "appendonly": "no",
        "maxmemory": "67108864", "maxmemory-policy": "allkeys-lru", "daemonize": "no",
        "dir": "/tmp", "pidfile": "", "logfile": "", "protected-mode": "yes",
    }
    assert result["redis_config"] == expected, "embedded Redis runtime settings changed"
    assert result["uid"] == result["gid"] == "65532"
    details = json.loads(docker("inspect", container, capture_output=True, text=True).stdout)[0]
    assert "6379/tcp" not in details["NetworkSettings"]["Ports"]
    addresses = [network["IPAddress"] for network in details["NetworkSettings"]["Networks"].values() if network["IPAddress"]]
    assert addresses
    docker("exec", container, HELPER, "private", addresses[0], stdout=subprocess.DEVNULL)
    docker("exec", container, HELPER, "readonly", stdout=subprocess.DEVNULL)
    return result
