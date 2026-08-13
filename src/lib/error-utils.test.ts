import { describe, expect, it } from "vitest";

import { errorToShow, normalizeError, verbatim } from "./error-utils";

/**
 * The failure a reader is shown is the server's, not ours.
 *
 * `wrapCommand` puts the name of the Tauri command on the front of every
 * rejected invoke. That is useful in a stack trace and worthless in a toast:
 * "Tauri command 'applyManifest' failed:" is four words about our plumbing in
 * front of the one sentence — `field is immutable`, `is forbidden` — that says
 * what to do next.
 */
describe("what a failure says on screen", () => {
  it("drops our framing and keeps the server's words", () => {
    expect(
      errorToShow(
        new Error(
          "Tauri command 'applyManifest' failed: deployments.apps \"api\" is forbidden"
        )
      )
    ).toBe('deployments.apps "api" is forbidden');
  });

  it("leaves an error that never had the framing alone", () => {
    expect(errorToShow(new Error("connection refused"))).toBe(
      "connection refused"
    );
    expect(errorToShow("plain string")).toBe("plain string");
  });

  /** Only at the front, and only ours: a quoted one in the body is content. */
  it("strips nothing from the middle of a message", () => {
    const message = "kubectl said: Tauri command 'x' failed: nope";
    expect(verbatim(message)).toBe(message);
  });
});

describe("whether an error is worth retrying", () => {
  /**
   * Would retry a verdict. Every Kubernetes error about an Ingress or a
   * NetworkPolicy names `networking.k8s.io`, so a substring match on
   * "network" read a flat 403 as a network blip and asked again until it
   * gave up.
   */
  it("does not retry a refusal that happens to name a network API group", () => {
    const refusal = normalizeError(
      new Error(
        'ingresses.networking.k8s.io is forbidden: User "dev" cannot list resource "ingresses"'
      )
    );
    expect(refusal.isRetryable).toBe(false);
  });

  it("still retries a real network failure", () => {
    expect(normalizeError(new Error("network unreachable")).isRetryable).toBe(
      true
    );
    expect(normalizeError(new Error("connection refused")).isRetryable).toBe(
      true
    );
  });
});
