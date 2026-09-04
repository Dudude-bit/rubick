# Diagnostics panel — design

Status: implemented. The backend landed 2026-08-15 and the panel with it;
the Tools block below was the last piece and landed 2026-09-04.
Scope and privacy default were chosen by the repository owner; the shape
below was delegated.
Date: 2026-08-15

> This header said "not implemented" for three weeks after it was. A stale
> status is worse than none: it made `debug_kubectl_plugins` — the ad-hoc
> command this panel replaced — look like the backend half of something
> unfinished, and it survived a cleanup sweep on that reading.

## The problem

A GUI app on macOS does not inherit the shell's `PATH`. Rubick works
around that by resolving the user's login-shell `PATH` at startup and
merging known locations into it (`shell::path`), then handing that list
to every binary it spawns. When it works, nobody notices. When it does
not, the failure surfaces as somebody else's error message.

The case that prompted this: a kubeconfig context authenticates with
`command: kubectl, args: [oidc-login, …]`. Without the
`kubectl-oidc_login` binary, kubectl answers

```
error: unknown command "oidc-login" for "kubectl"
```

and the auth terminal shows exactly that. The text names neither the
file kubectl wanted — the underscore spelling is not guessable from the
subcommand — nor the directories it searched. A reader learns that
something is wrong and nothing about what.

That specific failure is now refused before the spawn, with a message
that names the file and the search path
(`binaries::ensure_kubectl_plugin_present`). This design generalises it:
the same facts, on a screen, for the failures nobody has hit yet.

A second motivation is remote help. The bug above was on a second
machine, and diagnosing it meant writing a shell script for its owner to
run. The app already knows everything that script collects.

## What it is

A sixth Settings section, **Diagnostics**, that opens with what is wrong
and holds the whole environment underneath.

`settings-sections.ts` says its sections are "split by what kind of
decision each holds". Diagnostics holds no decision — it is state. So
does About, which is the existing precedent; the module doc gets updated
to say so rather than pretend the rule is unbroken.

### Findings first

The top of the page is a list of findings, worst first, each one
sentence naming the problem and what to do about it:

> **`kubectl-oidc_login` is not installed.** The context
> `orders-stage` authenticates with `kubectl oidc-login`, and kubectl
> looks for a binary of that name. Install it with
> `kubectl krew install oidc-login`, or point the context at an absolute
> command.

Worst first means, in order: something a context needs is absent, so a
connection will fail; a setting points at a file that is not what it
claims, so it will fail once something uses it; something optional is
missing, so a feature is unavailable. Within a rank, by context name, so
the order does not move between reads.

When there is nothing to say, the section says so plainly and the
environment stays available below. An empty findings list is a real
answer, not a blank.

This is the shape every integration page already uses — "6 of 6 broken,
and first", ordered by trouble, with the explanation under the finding.
A flat dump would make the reader derive the conclusion, which is the
thing this project exists not to do.

### The environment underneath

Collapsible blocks, each answering one question:

| Block       | Answers                                                                                |
| ----------- | -------------------------------------------------------------------------------------- |
| Search path | Which directories a spawned binary is looked for in, in order, and whether each exists |
| Tools       | kubectl, helm, kubelogin and the cloud CLIs: resolved path and version                 |
| Plugins     | Every `kubectl-*` any context needs, and whether it resolves                           |
| Contexts    | Per context: how it authenticates, and for `exec` the command and whether it was found |
| Kubeconfig  | Path, whether it parsed, how many contexts it holds                                    |
| Application | Version, OS, where the config file and logs live                                       |

### Copy diagnostics

One button produces the whole report as markdown for a chat message or
an issue.

**Redacted by default.** The home directory becomes `~`; context names
and API hostnames become `context-1`, `host-1`, consistently across the
report so the findings still read coherently. A toggle beside the button
turns redaction off for someone who knows what they are pasting.

The default matters: the report otherwise carries an employer's internal
hostnames into a public issue tracker, and the person pasting it is
usually not thinking about that.

## Structure

### Backend

New module `src-tauri/src/diagnostics/`:

- `collect.rs` — gathers the environment into one `Diagnostics` struct
- `findings.rs` — derives findings from that struct
- `redact.rs` — the consistent-substitution pass
- `mod.rs` — the facade

One Tauri command in `commands/diagnostics.rs`:

```rust
collect_diagnostics(redact: bool) -> Diagnostics
```

Findings are computed in Rust, not the frontend, because the connect-time
refusal already needs them. `ensure_kubectl_plugin_present` is refactored
to produce a `Finding` that the auth path renders as an error and the
panel renders as a row — one implementation, two consumers, no chance of
the screen and the connection disagreeing.

**Nothing here executes a binary named by a kubeconfig.** That rule is
already written down in `commands/binaries.rs`: a settings screen that
shelled out to every `command` a kubeconfig named would be running
arbitrary programs because somebody opened a pane. Versions come only
from the existing tool-availability path, which asks a fixed list of
known tools.

### Frontend

`src/components/settings/DiagnosticsSettings.tsx` plus one component per
block, in `src/components/settings/diagnostics/`. The section is
registered in `settings-sections.ts` and `Settings.tsx` like any other.

Data arrives through `useLiveQuery` — the environment can change while
the pane is open (a plugin installed in another window), and a
hand-written interval is a lint error anyway.

## Errors

Collection is best-effort per block. A kubeconfig that fails to parse
does not empty the page; it becomes a finding, and every other block
still answers. Each block carries its own "could not read" state rather
than the page having one.

## Testing

Rust:

- findings derived from a synthetic environment — a missing plugin, a
  tool override that is not executable, a context whose exec command is
  absent
- an environment with nothing wrong produces no findings
- redaction: the home directory and the original context names do not
  appear anywhere in a redacted report, and the same context maps to the
  same placeholder in every block

Frontend:

- findings render worst-first
- the empty state says nothing needs attention rather than rendering
  blank
- copy puts the redacted form on the clipboard, and the toggle changes it

## Deliberately not included

**A "fix it" button.** Installing a plugin means running a package
manager the app did not choose, on a machine whose conventions it does
not know. Naming the command precisely is help; running it is a
different feature with a different blast radius.

**Log viewing.** The app logs to stdout, which is nowhere when it is
launched from the Dock. Making logs readable is worth doing and is its
own piece of work; this panel says where they would go.

**Watching for changes.** The panel reads when it is open. A background
watcher on the filesystem to notice a plugin appearing is cost with no
reader.
