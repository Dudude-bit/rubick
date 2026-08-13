import { beforeEach, describe, expect, it } from "vitest";

import {
  credentialsExpired,
  credentialsRestored,
  expiryReason,
  isCredentialsExpired,
  readExpiredCredentials,
  subscribeToCredentials,
} from "./credentials";

beforeEach(() => credentialsRestored());

describe("recognising a session the cluster has stopped accepting", () => {
  /**
   * Would send every screen back to claiming the cluster is empty. Errors
   * cross the Tauri boundary as their `Display` string and nothing else, so
   * this prefix is the wire format — it is set by `Error::CredentialsExpired`
   * in `src-tauri/src/error.rs` and the two have to agree.
   */
  it("matches the marker the backend puts on a 401", () => {
    const wire =
      "Tauri command 'list_pods' failed: CREDENTIALS_EXPIRED: the cluster rejected this session's credentials — Unauthorized";
    expect(isCredentialsExpired(wire)).toBe(true);
    expect(expiryReason(wire)).toBe(
      "the cluster rejected this session's credentials — Unauthorized"
    );
  });

  /**
   * A 403 answers one request and leaves the session working. Reading it as an
   * expiry would throw the reader out of a cluster they are still using every
   * time they opened something their token cannot read.
   */
  it("does not match an ordinary refusal", () => {
    expect(
      isCredentialsExpired(
        'pods is forbidden: User "dev" cannot list resource "pods"'
      )
    ).toBe(false);
  });
});

describe("what the window is told", () => {
  /**
   * Every request in the window fails together. Whichever landed last is not
   * the one the reader is owed — the first sentence is, and it must not be
   * overwritten by the twelve that follow it in the same second.
   */
  it("keeps the first refusal until it is cleared", () => {
    credentialsExpired("the token is expired");
    credentialsExpired("something else entirely");
    expect(readExpiredCredentials()?.reason).toBe("the token is expired");

    credentialsRestored();
    expect(readExpiredCredentials()).toBeNull();
  });

  it("tells a subscriber on both edges, and only on a change", () => {
    const seen: (string | null)[] = [];
    const stop = subscribeToCredentials((state) =>
      seen.push(state?.reason ?? null)
    );

    credentialsExpired("expired");
    credentialsExpired("expired again");
    credentialsRestored();
    credentialsRestored();
    stop();

    expect(seen).toEqual(["expired", null]);
  });
});
