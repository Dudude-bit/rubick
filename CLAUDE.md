# Working in this repo

Tauri 2 + React 19 + TypeScript desktop Kubernetes client. Rust in `src-tauri/`,
frontend in `src/`, a shared crate in `k8s-gui-common/`, and the marketing site
in `web/` — a separate app that no workflow builds, lints or tests.

**bun, not npm.** `bun install`, `bun run test`, `bunx tsc --noEmit`.

[CONTRIBUTING.md](CONTRIBUTING.md) covers adding an integration and adding a
language. This file is the part that fails **silently** — the rules where
breaking them leaves the compiler, the linter, the tests and CI all green.

## The thesis, and the one defect class

The app exists to answer "I don't know" out loud. Almost every bug ever found
here is one shape: **a third state collapsing into the second** — "yes / no /
could not look" rendered as "yes / no".

The machinery is real and already in the code: `servingKnown`, `topologyKnown`,
`backingKnown`, `verdictsKnown`, `listenerSetsKnown`, `gatewaysKnown` and four
more `*Known` flags; `Existence::NotChecked`; `TraceStepState`'s `blind`;
`UnexploredKind` / `notLookedAt`.

- **Never answer a failed read with an empty collection or a default.** Carry
  the failure. `Vec::new()` on a 403 becomes "there are none" and then "this
  Gateway does not exist", in red, with nothing failing anywhere.
- **A knowable field defaults to unknown, not to known.** `listener_sets_known`
  defaulted to `true`, so every caller that forgot to merge the sets claimed
  the Gateway had none. Make the honest answer the one you get by forgetting.
- **A type that reduces a trace to a row or a badge carries the known bit next
  to the verdict.** A `serving: boolean` with no companion files an unknown
  trace under "serving".
- **Branch on `.known` before choosing a _tone_, not only a label.** A green
  node for an unread backend is the same lie as the words would have been.
- **Keep state→presentation maps total.** A `Record<State, X>` the compiler
  checks, not a lookup with a fallback that silently paints a new state neutral.
- **A test for "not found" must be impossible to satisfy with "could not
  look".** An assertion on an empty list is byte-identical to a swallowed 403,
  and enshrines the bug it was written to catch.
- Every new `blind` / `NotChecked` / `*Known` branch needs a test that fails
  when the branch is deleted.

## One fact, many readers

The other defect that keeps happening here, and the one no test has ever
caught. A fact from the cluster is read in several places; someone fixes the
reading in one of them; the rest keep the old answer. Nothing fails — two
screens simply disagree, and a user reports it.

Four in one day: an empty `status.addresses` fixed in the trace and not in the
sidebar's `pulseOf`; `listener_sets_known` merged on the route pages and not in
the connections graph or the watch payload; a `reachable` step saying "not
checked yet" beside a probe panel that had already answered; a `detail` field
carrying both the cluster's words and ours.

- **After fixing how a fact is read, grep the field name and fix every
  reader.** `grep -rn "addresses.length === 0"` finds the second one; memory
  does not. There is almost never only one.
- **The dangerous pairs are page ↔ sidebar badge, page ↔ peek panel, and
  list ↔ detail** — the same object drawn by different code.
- **A static line beside a live control is a lie waiting for a click.** If
  something nearby can learn the answer, the line has to learn it too.
- **The same kind is fetched by more than one path** — a list command, a get
  command, a watch closure, the connections graph. Enrichment applied in one
  is missing from the others unless you put it there.

## Verifying

Claims here are settled by running things, not by reasoning about them.

- **`cargo test --workspace`.** Never `--lib`: it does not build the binary,
  which is how v2.1.0 shipped with 90 `__cmd__X not found` errors.
- **Sabotage your own test.** Break the code and confirm it fails _for the right
  reason_. A test that passes against broken code is worse than none.
- **There is no pre-push hook.** Run `bun run test` and `bunx tsc --noEmit`
  yourself. Prettier runs only in the pre-commit hook and in no CI job at all,
  so bypassing the hook lands unformatted code on a green main.
- **Open the application** when the change is about what a person sees.
  `make apply-test-manifests` puts one of everything into the current context;
  `make dev` runs it. Before drawing a conclusion from a screenshot, check
  `ps -eo pid,command | grep Rubick` — an installed `/Applications/Rubick.app`
  looks exactly like your build and is not it.
- Some behaviour only exists on a cluster. `src-tauri/tests/live_*.rs` and
  `test-manifests/` are the harnesses; a `kind` cluster is enough for most.

## Frontend

- Call the backend through `commands` from `@/lib/commands` — never
  `@/generated/commands`, never `invoke`. The wrapper is the only place that
  normalises errors and notices an expired session.
- **Never spread a query result.** `{...q}` reads every field of React Query's
  tracking proxy and permanently disables per-field render tracking for that
  screen.
- A TanStack `cell` / `header` renderer is created **once** — at module level,
  or inside a column literal built once. `flexRender` treats a renderer as a
  component _type_, so a new arrow each render remounts the cell and the button
  under the pointer disappears mid-click. Memoize the `columns` array too.
- Polling goes through `useLiveQuery({ refresh: "<rate>" })` with a rate from
  `src/lib/refresh.ts`. A hand-written `refetchInterval` is a lint error, and
  the reason is that it polls a screen nobody is looking at.
- Anything that keeps a subtree mounted while off screen — Radix `forceMount`
  tabs, panels, sheets — must wrap it in a `SurfaceVisibility` provider set to
  `false`, or every `useLiveQuery` under it keeps polling at nobody.
- Build query keys with `queryKeys.*`. Do not spell "every namespace" as `""`,
  `null` or `"all"`: `all` is a namespace a cluster can really have.
- `<StatusBadge status={code}>{label}</StatusBadge>` — `status` is the raw
  Kubernetes code. `statusRole()` looks it up in a table and returns `neutral`
  on a miss, so a translated _or simply unlisted_ status turns the badge grey
  with every test still passing. A new status code goes in the table.
- Colours are role tokens (`bg-canvas`, `text-fg-mut`, `text-ok`, `border-hair`,
  …). No raw Tailwind colours, no `dark:`, no legacy shadcn tokens.
- `<select>` comes from `components/ui` — the native one is painted by the OS
  and is white in a dark window.
- Outside `src/integrations/`, ask for a facet (`useCapability`, `useCrdView`,
  `flavourOf`) and never name a vendor.
- **A watch replaces a row wholesale.** Whatever the watch closure builds is
  the whole row from the next tick on, so anything the closure cannot compute
  from the object alone has to be merged at render — never written into the
  watched cache entry, and never assumed to survive. This is how a Gateway
  correct on first read went wrong a second later.
- **The peek panel renders the same objects as the detail pages.** A fix on one
  leaves the other wrong; check both.

## Rust

- A new `#[tauri::command]` must also be added to `tauri::generate_handler![…]`
  in `main.rs`. The TypeScript binding is generated from the attribute and
  type-checks whether or not the command was ever registered.
- Declare a command `async` whenever it spawns, directly or through a manager.
  Tauri runs sync commands off the reactor, where `tokio::spawn` panics — and a
  panic across the IPC boundary is not a stack trace, it is silence.
- Validate any name that came from the frontend with
  `crate::validation::validate_dns_label` / `validate_dns_subdomain`.
- Spawn external binaries through `crate::shell::ShellCommand`. A GUI app
  inherits a stripped `PATH`, so `std::process::Command` works under
  `cargo run` from your terminal and not in the shipped app.
- Write `config.toml` only through `crate::config::private_file::write` — it
  holds bearer tokens, and `std::fs::write` leaves them world-readable.
- Ask `Error::is_refusal()` whether the cluster refused. A 403 stays
  `Error::KubeApi`; only 401 has its own variant.
- Do not touch the text of `Error::CredentialsExpired` — the `CREDENTIALS_EXPIRED:`
  prefix _is_ the wire format the frontend matches on.
- Inside a long-running task, get the client per attempt from
  `state.client_manager`; a held `kube::Client` carries a token that expires.
- A spawned operation that emits events waits on its subscribe gate, exposes a
  `<thing>_subscribed` command to release it, and **always** emits its terminal
  event — including on cancel and on early error. Tauri events have no replay.
- Event payloads are hand-written flat `serde_json::json!` arms with snake_case
  keys; command return types are camelCase via serde. The two halves of the IPC
  boundary use opposite casing on purpose.

## Connections and traces

The graph and the route trace are where the thesis is actually enforced, and
each has a contract nothing checks for you.

- A new kind arm in `connections_of` must fill `not_looked_at` for every kind
  it did not read. The default is an empty vec, and the wire contract reads
  that as "every kind was read".
- `object.related` returns `null` for a kind a vendor does not own and `[]` for
  one it owns and found nothing in. Collapsing the two makes another vendor's
  answer disappear.
- `TraceStep.who` is load-bearing, not a label: `servingKnown` ignores blind
  steps whose `who` is `"machine"`. Reuse it only for the unprobed last mile —
  a cluster-read step tagged that way silently claims a verdict is knowable.
- A `ConnRow` whose group claims anything that depends on the object existing
  must set `verifiable: true`; the render site hides `notChecked` otherwise.
- Implementations of `delivery.source` and `ingress.tls` answer **positionally**
  — same length as the input, a hole rather than a dropped element. The caller
  indexes the answer by row.

## Words the reader sees

- **Never translate** kind names, status values, condition types and reasons,
  API field names, PromQL, or anything the cluster wrote. A reader matches
  `CrashLoopBackOff` against their terminal.
- A sentence composed in **Rust** ships as a `#[serde(tag = "says")]` enum the
  frontend switches on. A literal written in `src-tauri/` is invisible to every
  scanner, test and lint in this project — all of them walk `src/`.
- A sentence composed in a `queryFn`, or in a module-level table, stores a
  `Saying` (`{key, values}`) and becomes words at render. A `t` called inside a
  query freezes the language into the cache.
- A sentence with markup inside it stays **one** catalogue string with a
  placeholder, substituted by `parts()`. Splitting it pins the word order.
- Never build a count as `${n} noun${n === 1 ? "" : "s"}`. Russian has three
  forms; use the catalogue's plural object. No whole string exists for a
  scanner to find in this pattern, which is how it survives every sweep.
- Singulars come from `toSingularNoun()`, not `replace(/s$/, "")` — that
  printed "1 ingresse".
- Pass a value for every `{placeholder}`: an unsupplied one renders literally.
- The translator is `t(section, key, values?)` — two positional arguments, not
  a dotted path.
- **Nothing checks that copy was translated.** No lint rule, no test. The only
  check is opening the screen.

## Tests

- A frontend test lives beside its subject as `<name>.test.ts(x)` under `src/`.
  A `__tests__/` folder or any other suffix is collected by nothing and reports
  nothing.
- Rust unit tests go in an inline `#[cfg(test)] mod tests` in the file they
  cover. `src-tauri/tests/` is reserved for the `#[ignore]`d live harnesses.
- Name a test as a sentence stating the behaviour, with a doc comment above
  saying what would break. No `should`, no bare function names — nothing in
  1918 test names here starts with "should".
- **No snapshots.** Assert the behaviour, not the markup. A snapshot
  re-recorded on failure asserts whatever the code now does.
- `src/lib/__fixtures__/*.json` are recordings of what a real controller wrote.
  Never hand-edit them; regenerate with the ignored Rust dumper against the
  specimen cluster.
- The table guards — `resource-registry.test.ts`, `catalogue.test.ts`,
  `vendor-copy.test.ts`, `release-assets.test.ts` — each encode a contract
  nothing else states. When one fails, the code is wrong, not the table.
- Touch a log query term and both evaluators must agree: add the cases to
  `shared/log-query-conformance.json` and run the Rust and the TypeScript side.
  The same holds for the pod status the builder derives from a pasted manifest —
  `shared/pod-status-conformance.json`, against `pod_display::display_status`.
  Where one question has two evaluators, the corpus is what makes them one
  answer; a doc comment listing what the second one does not implement is a
  record of the drift, not a check on it.
- A number both halves of the IPC boundary apply lives in `shared/`, with a
  test on **each** side asserting its own constant matches the file. A
  comment saying "mirrored" is not a check; `MAX_PROBLEMS` was one for a
  year. Changing the value means changing the shared file, not a constant.

## Tooling

- `src/generated/{commands,types}.ts` are generated. Never hand-edit them.
  Regenerate with `make gen-entities-tauri` — which needs `cargo-expand`,
  without which it silently drops every macro-generated `subscribe_*_watch`
  binding. If it refuses because the command count dropped, that is the guard
  working: `git checkout -- src/generated/`, or say `REMOVED=n` if you deleted
  n commands on purpose.
- Keep every `no-restricted-syntax` selector in the **one** config block in
  `eslint.config.js`. A second config object naming that rule _replaces_ the
  list rather than extending it, switching off all of the guards above at once.
- `bun run lint` runs with `--max-warnings 0 --report-unused-disable-directives`,
  so every "warn" rule is a hard failure and a stale `eslint-disable` is an
  error. An unused caught error must be `catch {` with no binding — `catch (_e)`
  is not exempt.
- ESLint never reads `src-tauri/`, `web/`, `src/generated/`, `dist/` or any
  `*.config.*`. Nothing guards the code there.
- A duplicated npm package is fixed by `rm -rf node_modules bun.lock &&
bun install` — never `bun add pkg@ver`, never an `overrides` entry. Two copies
  of one package do not error; they make one copy's objects silently invisible
  to the other.

## Adding a resource kind

Half-done is invisible: each of these fails by the kind simply not appearing.

`RESOURCE_REGISTRY` entry · a route file under the right section · the item in
the Sidebar `GROUPS` · a `nav` key in **both** `catalogue.ts` and `ru.ts` ·
optionally a `subscribe_*_watch` command, which must also be registered in
`generate_handler!`.

Adding an integration is one folder and one line — [CONTRIBUTING](CONTRIBUTING.md)
has it — but two things it does not say: a **detected** vendor needs its id in
the Rust markers table with the exact same string, or it is permanently
not-installed; and a **configured** vendor's capabilities are read through
`useCapabilityState`, never `useCapability`, which only knows the detection
scan.

## Releasing

Bump the version in **four** files in one commit — `package.json`,
`src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml`, `k8s-gui-common/Cargo.toml`
— then refresh `Cargo.lock`. Nothing compares them, so a partial bump releases
green with artifacts whose names disagree with the tag.

Write the `## [X.Y.Z] - YYYY-MM-DD` section in `CHANGELOG.md` **before** pushing
the tag: the workflow awk-extracts that exact heading for the release body and
otherwise attaches the whole file behind a warning nobody reads.

Push `vX.Y.Z`. The build produces a **draft** on purpose. Find it with
`gh release list` — `GET /releases/tags/{tag}` returns 404 for drafts even to
the owner — and publish it by hand.

## Commits

Short messages, minimal comments, no `Co-Authored-By` trailers.
