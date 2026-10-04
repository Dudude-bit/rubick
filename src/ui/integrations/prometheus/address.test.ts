import { describe, expect, it } from "vite-plus/test";

import { addressOf } from "./address";

describe("the Prometheus address a shared file names", () => {
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
});
