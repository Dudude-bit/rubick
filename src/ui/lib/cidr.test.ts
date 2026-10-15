import { describe, expect, it } from "vite-plus/test";

import { inCidr } from "./cidr";

describe("whether an address is inside an ipBlock", () => {
  /** A pod CIDR admitting the controller read as refusing it. */
  it("places IPv4 addresses inside and outside a block by its prefix", () => {
    expect(inCidr("10.42.1.7", "10.42.0.0/16")).toBe(true);
    expect(inCidr("10.43.1.7", "10.42.0.0/16")).toBe(false);
    expect(inCidr("192.168.5.5", "0.0.0.0/0")).toBe(true);
    expect(inCidr("10.42.0.1", "10.42.0.1/32")).toBe(true);
  });

  /** Fails if the :: expansion or an embedded IPv4 tail is misread. */
  it("reads IPv6 blocks, compressed and with an IPv4 tail", () => {
    expect(inCidr("fd00:10:42::7", "fd00:10:42::/48")).toBe(true);
    expect(inCidr("fd00:10:43::7", "fd00:10:42::/48")).toBe(false);
    expect(inCidr("::ffff:10.0.0.1", "::ffff:10.0.0.0/120")).toBe(true);
  });

  /** An address of the other family is never inside; text that is not an address cannot say. */
  it("keeps the families apart and cannot say for what it cannot parse", () => {
    expect(inCidr("10.0.0.1", "::/0")).toBe(false);
    expect(inCidr("10.0.0.300", "10.0.0.0/8")).toBeNull();
    expect(inCidr("10.0.0.1", "10.0.0.0/33")).toBeNull();
    expect(inCidr("10.0.0.1", "10.0.0.0")).toBeNull();
  });
});
