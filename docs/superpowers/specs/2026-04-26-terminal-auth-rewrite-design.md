# Terminal-Auth Subsystem Rewrite — Design

**Date:** 2026-04-26
**Driver:** OIDC interactive auth dialog renders an empty xterm. User can't log in to clusters that need `kubectl-oidc_login`. Confirmed by user screenshot + 3-agent investigation.

## Confirmed root causes

1. **Race window between backend I/O loop start and frontend listener registration.** `manager.rs` spawns the read loop the instant `adapter.connect()` returns; events emitted before the frontend's async `listen("terminal-output")` callback is registered are dropped. Bytes are gone — Tauri events have no replay.
2. **`AuthExecAdapter` uses pipes, not a PTY.** `kubectl-oidc_login` and similar drivers expect a TTY for interactive prompts. With raw pipes, the auth tool may not write its prompt at all, may buffer it indefinitely, or may write it to stdout (which adapter swallows on purpose — see below).
3. **`AuthExecAdapter::read_output` deliberately drops stdout.** Lines 92-97: stdout is collected for JSON parsing only and never returned to the terminal. If kubelogin sends prompts to stdout (under any condition), the user sees nothing.
4. **Context + command props arrive empty in the dialog header.** `useAuthFlowEvents` reads them from the `auth-terminal-session-created` event payload, which is constructed in `interactive.rs` around line 379. Need to verify the payload always has non-empty values.

## Goals

- The OIDC auth modal shows kubelogin's prompts the moment they appear, in real time.
- The user can type into the terminal and the keystrokes reach the auth process.
- The "Context:" header shows the cluster context name.
- The same fix removes the same class of race for `PodTerminal`.
- We have automated tests that would catch a regression of the race or the dropped-stdout bug.

## Non-goals

- Replacing the entire xterm component.
- Changing the AuthFlowEvent schema.
- Touching log streaming or other adapters (kubectl exec subsystem stays unchanged for now).
- Migrating the dialog UX to a non-modal layout.

## Architecture

Three coordinated changes, all small individually.

### Change 1 — Deferred-start session API (backend + frontend handshake)

The fundamental fix for the race. Pattern: backend creates the session and the I/O loop, but the loop blocks on a "subscribed" gate until the frontend signals it has registered listeners.

Backend (`src-tauri/src/terminal/manager.rs` + `commands/terminal.rs`):

- Add a `subscribe_signal: Arc<Notify>` (or a `tokio::sync::oneshot::Sender<()>` stored on the session) created inside `create_session`.
- The spawned I/O loop awaits the signal before entering the read/write select loop. The `connect()` call still happens immediately so adapter init errors surface fast — only the _output reading_ is gated.
- New Tauri command:
  ```rust
  #[tauri::command]
  pub fn terminal_subscribed(
      session_id: String,
      state: State<'_, AppState>
  ) -> Result<(), String>
  ```
  Looks up the session, releases the gate. Idempotent (calling twice is a no-op).

Frontend (`src/hooks/useGenericTerminalSession.ts`):

- After both `listen("terminal-output", ...)` and `listen("terminal-closed", ...)` resolve successfully, call `commands.terminalSubscribed(sessionId)`.
- If `terminalSubscribed` fails, surface as an error state — better than silent loss.

This eliminates the race by construction. Earliest a frontend can miss output is after it has explicitly told the backend "I'm ready."

### Change 2 — `AuthExecAdapter` over a PTY

Replace pipe-based stdio with a portable PTY (the same crate `PodExecAdapter` uses — likely `portable-pty`).

- Drop the separate `stdout` / `stderr` fields. Single PTY master/slave pair.
- `read_output`: read PTY master, return all bytes to the terminal.
- `write_input`: write to PTY master.
- `resize`: send PTY resize ioctl (already supported by `portable-pty`).
- The "collect stdout for JSON parsing" mechanism: keep it as a separate concern. The auth flow that needs to parse JSON output (`kubelogin --output=json` style) can still tee a copy of bytes into the collector while also forwarding to the terminal. That preserves the existing JSON-extraction path.
- Drop the `MAX_STDOUT_SIZE = 1MB` cap, OR keep it on the _collector_ only. The terminal stream itself is already bounded by xterm's scrollback.

PTY makes kubelogin's interactive prompts work the way the user expects. It also matches the convention `PodExecAdapter` already follows, so two of the three terminal adapters now share a PTY backbone.

### Change 3 — Context + command propagation guarantee

`interactive.rs` around line 379 constructs the `auth-terminal-session-created` event payload. Audit:

- Is `params.command` derived from the actual exec command (e.g. `"kubectl-oidc_login"` plus first arg), or is it left blank?
- Is `context` derived from the kubeconfig context being authenticated, or pulled from a stale field?

The fix is small (probably setting two fields that are currently `String::new()` or `None`) but the test must assert that the dialog renders the context name from the event.

### Migration: PodTerminal to deferred-start

Once Change 1 lands, `PodTerminal` benefits for free if it routes through the same hook. Verify it does, or add the `terminalSubscribed` call in its hook path. No new bug expected — pod exec is interactive enough that the user typically buffers their first keystroke until the prompt appears, masking the race in practice. We close the window anyway.

## TDD plan

In TDD order:

1. **Characterization tests** for what currently works in `AuthTerminal.tsx`:
   - Renders a Dialog titled "Authentication Required".
   - Shows the `context` prop in the header.
   - Cancel button calls `commands.cancelAuthSession(authSessionId)` then `onClose`.
   - When the underlying terminal emits `onClose`, the dialog calls `onClose`.
2. **Failing test** for the desired behaviour:
   - Mount `AuthTerminal` with a session ID.
   - Mock `commands.terminalSubscribed` and `listen("terminal-output", ...)`.
   - Assert that the listener registers BEFORE `terminalSubscribed` is called (assert ordering: listener registration must happen before subscribe call).
   - Assert that emitting a `terminal-output` event with the correct session ID after subscribe results in the data being passed to the xterm component.
3. **Backend test** (Rust integration test):
   - `TerminalManager::create_session` then `read_output` should NOT have produced any events until `terminal_subscribed` is called.
4. **Implement Change 1** until tests #2 + #3 pass.
5. **Implement Change 2** (PTY) — adds a backend test that a kubelogin-shaped fake binary's stdout AND stderr both reach `read_output`.
6. **Implement Change 3** (context propagation) — extend test #2 to assert the context value is non-empty in the rendered header.
7. **Migrate PodTerminal** — characterization test that PodTerminal still mounts and pod-exec smoke test still runs (no functional regression).

## Sequencing

- PR1: Spec doc + characterization tests for AuthTerminal (this PR).
- PR2: Failing test for ordering + Change 1 backend (`terminal_subscribed` API + gate). Test goes from red to green.
- PR3: Change 1 frontend wiring (`terminalSubscribed` call in hook). Existing PodTerminal still works.
- PR4: Change 2 — `AuthExecAdapter` PTY rewrite. Adds backend integration test.
- PR5: Change 3 — context propagation fix + assertion in the failing test from PR2.
- PR6: PodTerminal migration verification + closeout.

Each PR is small and ships value. PR4 is the largest (touches Cargo deps if `portable-pty` isn't already in there).

## Risks

- **`portable-pty` cross-platform**: kubelogin spawn behaviour might differ on Windows. PodExecAdapter already uses this path, so the cross-platform story is presumably solved — verify by reading PodExecAdapter.
- **Subscribe command is a new attack-shape Tauri call**: it must reject unknown session IDs (so a malicious frontend / extension can't release arbitrary sessions). Easy: only accept if the session is in the manager's map.
- **Race on `terminal_subscribed` failure**: if the frontend never calls it (e.g. browser crash), backend holds the session indefinitely. Mitigate with a 60s timeout that auto-releases the gate AND emits a "terminal-startup-timeout" log so the issue is visible.

## Tests we will write

- `AuthTerminal.test.tsx` — characterization (4 cases) + failing-then-passing ordering + context propagation (~7 cases total).
- `useGenericTerminalSession.test.ts` — listener-registers-before-terminalSubscribed-call (~3 cases).
- Rust unit test on `TerminalManager` — gate held until `terminal_subscribed` (~2 cases).
- Rust integration test on `AuthExecAdapter` with a fake binary — both stdout+stderr reach the consumer (~2 cases).

## Success criteria

- Manual test: connect to an OIDC cluster (orders-dev). Dialog opens, kubelogin prompts visible, user types password, login completes.
- `npm test` total goes from 70 → ~85 tests. `cargo test` from 113+6 → ~117+6.
- Build green on CI for all 4 platforms (build.yml).
- Two follow-up commits update `MEMORY.md` with the new pattern (deferred-start) so future terminal additions follow it.
