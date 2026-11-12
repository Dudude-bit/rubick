import { describe, expect, it } from "vite-plus/test";

import { addressOf } from "./address";

describe("a saved address as it is drawn", () => {
  /**
   * `https://user:pass@host` is how this app reaches a basic-auth
   * Prometheus, and the file printed it whole beside "no authentication".
   */
  it("leaves the credentials out and says they are there", () => {
    expect(addressOf("https://admin:S3cret@prom.example.com/")).toEqual({
      shown: "prom.example.com",
      basic: true,
    });
  });

  it("names an address without credentials as it is", () => {
    expect(addressOf("http://localhost:20001")).toEqual({
      shown: "localhost:20001",
      basic: false,
    });
  });

  /**
   * An address typed without a scheme does not parse as one, and the row
   * that says it did not answer printed it whole, password included. Fails
   * if the credentials are cut only from an address a URL parser accepts.
   */
  it("leaves them out of an address too malformed to parse", () => {
    expect(addressOf("admin:S3cret@prom.internal:9090/prometheus")).toEqual({
      shown: "prom.internal:9090/prometheus",
      basic: true,
    });
    expect(addressOf("https://admin:S3@cret@prom.example.com").shown).toBe(
      "prom.example.com"
    );
  });

  /** An `@` after the host is part of the path, not a credential before it. */
  it("keeps an at sign that stands in the path", () => {
    expect(addressOf("https://prom.example.com/tenant@eu")).toEqual({
      shown: "prom.example.com/tenant@eu",
      basic: false,
    });
  });
});
