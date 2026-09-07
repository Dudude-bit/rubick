#!/usr/bin/env python3
"""A cluster big enough to make the app stall, and the churn to keep it stalling.

Ten thousand Pending pods cost nothing to run and everything to list, which is
the shape of the clusters people report as slow. `churn` then patches
annotations at a chosen rate so the watch stream carries real events while
Diagnostics records. Numbers from anything smaller are not numbers.

    scripts/perf-rig.py up            # create the cluster and 10 000 pods
    scripts/perf-rig.py churn -r 100  # 100 updates per second, until Ctrl-C
    scripts/perf-rig.py logs          # five pods writing 50 lines per second
    scripts/perf-rig.py status
    scripts/perf-rig.py down

Uses the current kubectl context unless --context is given; `up` creates a
kind or k3d cluster named rubick-perf when neither exists yet.
"""

import argparse
import json
import os
import random
import shutil
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request

CLUSTER = "rubick-perf"
NAMESPACES = 10


def kubectl(context, *args, stdin=None, check=True, capture=False):
    cmd = ["kubectl", "--context", context, *args]
    return subprocess.run(
        cmd,
        input=stdin,
        text=True,
        check=check,
        stdout=subprocess.PIPE if capture else subprocess.DEVNULL,
        stderr=None if check else subprocess.DEVNULL,
    )


def context_exists(context):
    out = subprocess.run(
        ["kubectl", "config", "get-contexts", "-o", "name"], text=True, capture_output=True
    ).stdout.split()
    return context in out


def create_cluster():
    if shutil.which("kind"):
        subprocess.run(["kind", "create", "cluster", "--name", CLUSTER], check=True)
        return f"kind-{CLUSTER}"
    if shutil.which("k3d"):
        subprocess.run(["k3d", "cluster", "create", CLUSTER, "--no-lb"], check=True)
        return f"k3d-{CLUSTER}"
    sys.exit("neither kind nor k3d is installed; pass --context for an existing cluster")


def pod(i, ns):
    return {
        "apiVersion": "v1",
        "kind": "Pod",
        "metadata": {
            "name": f"p-{i:05}",
            "namespace": ns,
            "labels": {"app": f"app-{i % 50}", "perf.rubick/rig": "true"},
            "annotations": {"perf.rubick/churn": "0"},
        },
        "spec": {
            "nodeSelector": {"perf.rubick/unschedulable": "true"},
            "containers": [{"name": "pause", "image": "registry.k8s.io/pause:3.10"}],
        },
    }


def apply_list(context, items):
    body = json.dumps({"apiVersion": "v1", "kind": "List", "items": items})
    kubectl(context, "apply", "-f", "-", stdin=body)


def wait_for_service_accounts(context):
    """A pod submitted before its namespace's default ServiceAccount exists is refused."""
    for n in range(NAMESPACES):
        for _ in range(60):
            if kubectl(context, "get", "serviceaccount", "default", "-n", f"perf-{n}", check=False).returncode == 0:
                break
            time.sleep(0.5)
        else:
            sys.exit(f"perf-{n}: the default ServiceAccount never appeared")


def up(args):
    context = args.context
    if not context:
        context = next((c for c in (f"kind-{CLUSTER}", f"k3d-{CLUSTER}") if context_exists(c)), None)
        context = context or create_cluster()
    apply_list(
        context,
        [{"apiVersion": "v1", "kind": "Namespace", "metadata": {"name": f"perf-{n}"}} for n in range(NAMESPACES)],
    )
    wait_for_service_accounts(context)
    per_ns = args.pods // NAMESPACES
    batch = 200
    for start in range(0, args.pods, batch):
        items = [pod(i, f"perf-{min(i // per_ns, NAMESPACES - 1)}") for i in range(start, min(start + batch, args.pods))]
        apply_list(context, items)
        print(f"\r{min(start + batch, args.pods)} / {args.pods} pods", end="", flush=True)
    print(f"\ncontext {context}: {args.pods} Pending pods in {NAMESPACES} namespaces")


class Proxy:
    """`kubectl proxy` on a random port, so patches are HTTP calls and not a process each."""

    def __init__(self, context):
        self.proc = subprocess.Popen(
            ["kubectl", "--context", context, "proxy", "--port", "0"],
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            text=True,
        )
        line = self.proc.stdout.readline()
        self.base = "http://" + line.split("on ")[-1].strip()

    def patch(self, ns, name, body):
        req = urllib.request.Request(
            f"{self.base}/api/v1/namespaces/{ns}/pods/{name}",
            data=json.dumps(body).encode(),
            method="PATCH",
            headers={"Content-Type": "application/merge-patch+json"},
        )
        with urllib.request.urlopen(req, timeout=10) as res:
            res.read()

    def close(self):
        self.proc.terminate()


def churn(args):
    context = args.context or current_context()
    proxy = Proxy(context)
    per_ns = args.pods // NAMESPACES
    done = 0
    errors = 0
    lock = threading.Lock()
    stop = threading.Event()
    interval = 1.0 / args.rate

    def worker():
        nonlocal done, errors
        while not stop.is_set():
            i = random.randrange(args.pods)
            ns = f"perf-{min(i // per_ns, NAMESPACES - 1)}"
            try:
                proxy.patch(ns, f"p-{i:05}", {"metadata": {"annotations": {"perf.rubick/churn": str(time.time_ns())}}})
                with lock:
                    done += 1
            except (urllib.error.URLError, OSError):
                with lock:
                    errors += 1
            time.sleep(interval * args.workers)

    threads = [threading.Thread(target=worker, daemon=True) for _ in range(args.workers)]
    for t in threads:
        t.start()
    started = time.time()
    try:
        while args.seconds == 0 or time.time() - started < args.seconds:
            time.sleep(1)
            elapsed = time.time() - started
            print(f"\r{done} updates, {errors} errors, {done / elapsed:.0f}/s achieved of {args.rate}/s asked", end="", flush=True)
    except KeyboardInterrupt:
        pass
    finally:
        stop.set()
        proxy.close()
        print()


def logs(args):
    context = args.context or current_context()
    items = []
    for i in range(args.pods):
        items.append(
            {
                "apiVersion": "v1",
                "kind": "Pod",
                "metadata": {"name": f"logger-{i}", "namespace": "perf-0", "labels": {"perf.rubick/rig": "true", "app": "logger"}},
                "spec": {
                    "restartPolicy": "Always",
                    "containers": [
                        {
                            "name": "logger",
                            "image": "busybox:1.37",
                            "command": ["sh", "-c", f"i=0; while true; do i=$((i+1)); echo \"$(date +%T.%N) INFO logger-{i} line $i key=value\"; usleep {int(1_000_000 / args.rate)}; done"],
                        }
                    ],
                },
            }
        )
    apply_list(context, items)
    print(f"{args.pods} log producers at {args.rate} lines/s each in perf-0 (need a schedulable node)")


def status(args):
    context = args.context or current_context()
    out = kubectl(context, "get", "pods", "-A", "-l", "perf.rubick/rig=true", "--no-headers", capture=True, check=False).stdout
    lines = [l for l in out.splitlines() if l.strip()]
    pending = sum(1 for l in lines if " Pending " in l)
    print(f"context {context}: {len(lines)} rig pods, {pending} Pending")


def down(args):
    context = args.context or current_context()
    if context in (f"kind-{CLUSTER}",) and shutil.which("kind"):
        subprocess.run(["kind", "delete", "cluster", "--name", CLUSTER], check=True)
    elif context in (f"k3d-{CLUSTER}",) and shutil.which("k3d"):
        subprocess.run(["k3d", "cluster", "delete", CLUSTER], check=True)
    else:
        for n in range(NAMESPACES):
            kubectl(context, "delete", "namespace", f"perf-{n}", "--wait=false", check=False)
        print(f"rig namespaces deleted from {context}; the cluster itself was not ours to remove")


def current_context():
    return subprocess.run(["kubectl", "config", "current-context"], text=True, capture_output=True, check=True).stdout.strip()


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--context", help="kubectl context; default: the rig cluster, else the current context")
    sub = p.add_subparsers(dest="cmd", required=True)
    s = sub.add_parser("up")
    s.add_argument("--pods", type=int, default=10_000)
    s.set_defaults(fn=up)
    s = sub.add_parser("churn")
    s.add_argument("-r", "--rate", type=float, default=100, help="updates per second")
    s.add_argument("-s", "--seconds", type=int, default=0, help="0 = until Ctrl-C")
    s.add_argument("--pods", type=int, default=10_000)
    s.add_argument("--workers", type=int, default=8)
    s.set_defaults(fn=churn)
    s = sub.add_parser("logs")
    s.add_argument("--pods", type=int, default=5)
    s.add_argument("-r", "--rate", type=float, default=50, help="lines per second per pod")
    s.set_defaults(fn=logs)
    sub.add_parser("status").set_defaults(fn=status)
    sub.add_parser("down").set_defaults(fn=down)
    args = p.parse_args()
    if args.cmd != "up" and not args.context:
        for c in (f"kind-{CLUSTER}", f"k3d-{CLUSTER}"):
            if context_exists(c):
                args.context = c
                break
    args.fn(args)


if __name__ == "__main__":
    if os.name == "nt":
        sys.exit("the rig script expects a POSIX shell for its log producers; run it from WSL")
    main()
