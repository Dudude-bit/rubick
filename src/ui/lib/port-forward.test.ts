import { describe, expect, it } from "vite-plus/test";

import { suggestedLocalPort } from "./port-forward";

describe("the local port a forward offers", () => {
  /** Below 1024 needs root on Linux and macOS: 80 seeded 80 and failed. */
  it("lifts a privileged port to the number people already type", () => {
    expect(suggestedLocalPort(80, new Set())).toBe(8080);
    expect(suggestedLocalPort(443, new Set())).toBe(8443);
  });

  it("keeps a port a normal user may listen on", () => {
    expect(suggestedLocalPort(5432, new Set())).toBe(5432);
  });

  /** Two forwards to two pods on 80 must not both offer 8080. */
  it("steps past a port this app is already forwarding", () => {
    expect(suggestedLocalPort(80, new Set([8080, 8081]))).toBe(8082);
  });
});
