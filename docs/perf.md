# Performance: the rig, the recorder, the budget

"No freezes, no stutters" is a requirement, not a hope. This is how it is
measured and what a change has to stay under.

## The budget

Every PR that touches a list, a watch, a chart, the log viewer or the YAML
editor states its numbers against these, before and after.

| What                                                              | Budget                                                              |
| ----------------------------------------------------------------- | ------------------------------------------------------------------- |
| Application work per frame at 60 Hz                               | ≤ 8 ms of the 16.7 ms                                               |
| Synchronous work per event (watch batch, metrics tick, keystroke) | p99 ≤ 4 ms, never above 8 ms                                        |
| Long tasks (main thread blocked ≥ 50 ms) caused by the app        | zero                                                                |
| One IPC message                                                   | ≤ 256 KiB target, 1 MiB hard limit; larger answers arrive in chunks |
| Rows in the DOM                                                   | bounded by the viewport; anything past 100 rows is virtualised      |
| Input to paint under load                                         | p95 ≤ 50 ms                                                         |

The IPC numbers live in `shared/ipc-budget.json`, with a test on each side
of the boundary holding its constant equal to the file, the same way
`MAX_PROBLEMS` does. Nothing enforces them at runtime yet; the recorder
paints an answer over the target in the warning tone so a PR cannot miss it.

## The rig

A 10 000-pod cluster that costs nothing to run: the pods stay Pending on a
node selector nothing matches, which is exactly as expensive to list, watch
and render as running ones.

```sh
make perf-rig                 # kind or k3d cluster "rubick-perf", 10 namespaces, 10 000 pods
make perf-churn PERF_RATE=100 # patch annotations at 100/s so the watch carries events
python3 scripts/perf-rig.py logs   # five pods writing 50 lines/s each (needs a schedulable node)
python3 scripts/perf-rig.py status
make perf-rig-down
```

`churn` goes through `kubectl proxy` so an update is an HTTP call, not a
process; it prints the achieved rate beside the asked one, and the achieved
one is the number to quote.

## The recorder

Settings › Diagnostics › Performance. Off by default: while it runs every
backend answer is serialised a second time to count its bytes, which is a
cost nobody asked for on a screen nobody is measuring.

What one recording holds:

- **Backend calls.** Every command through `commands`: count, p50, p95, max,
  the largest row count and the largest answer in bytes.
- **Long tasks.** From the `longtask` observer where the webview has one
  (Chromium-based), otherwise a late animation frame counts as one and the
  report says which source it used.
- **Renders.** `DataTable`, `LogList`, `ConnectionsPanel` and `UsageChart`
  sit inside a React Profiler. React reports render timings only from a dev
  or profiling build, so a release build shows none and says so.
- **Backend counters.** Events pushed over the bridge, their total and
  largest payload, and how many watch changes they carried.

"Copy report" puts the whole thing on the clipboard as JSON for a PR
description.

## The scenarios

Record each one on the rig, before and after a change, from a release build
(`bun run tauri build`) for timings and from `make dev` for render counts:

1. Open Pods, all namespaces, and let the first load finish.
2. Scroll the pod list top to bottom, then sort by name and by age.
3. Leave the list open for one minute with `make perf-churn PERF_RATE=100`,
   then with `PERF_RATE=1000`; note the achieved rates.
4. Open Settings over the list and close it.
5. Scope to four namespaces and repeat 3.
6. Open a Deployment's YAML and type for ten seconds.
7. Diff two 10 000-line YAML documents.
8. Open Logs on a producer pod from `perf-rig.py logs` and type in the filter.

Quote p95 and max per command, the long-task count, the largest IPC
message, and the achieved churn rate.
