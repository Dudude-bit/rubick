import { describe, expect, it } from "vite-plus/test";

import { nodeMatcher } from "./node-names";

describe("which node a name from Prometheus means", () => {
  /**
   * Tencent TKE and Huawei CCE name nodes by address, Alibaba ACK by region
   * and address. Compared on the first dot-separated label every one of them
   * was `10` (or `cn-hangzhou`), so one node's series was every node's and
   * another cluster's node passed for this one's. Fails if two names that
   * only share leading labels are taken for one node.
   */
  it("tells nodes named by address apart, and from another cluster's", () => {
    const byAddress = nodeMatcher(["10.0.1.5", "10.0.1.6"]);
    expect(byAddress("10.0.1.5")).toBe("10.0.1.5");
    expect(byAddress("10.0.1.6:10250")).toBe("10.0.1.6");
    expect(byAddress("10.9.9.9")).toBeNull();

    const byRegion = nodeMatcher([
      "cn-hangzhou.10.0.1.5",
      "cn-hangzhou.10.0.1.6",
    ]);
    expect(byRegion("cn-hangzhou.10.0.1.6")).toBe("cn-hangzhou.10.0.1.6");
    expect(byRegion("cn-hangzhou.10.9.9.9")).toBeNull();
    expect(byRegion("cn-hangzhou")).toBeNull();
  });

  /**
   * EKS: the node is the full name and the scrape target often the short
   * one, or the other way round. Fails if only identical spellings match,
   * which reports every such cluster as unwatched.
   */
  it("takes a short spelling for the one node whose name it begins, either way round", () => {
    const long = nodeMatcher(["ip-10-0-1-4.eu-west-1.compute.internal", "n2"]);
    expect(long("IP-10-0-1-4")).toBe("ip-10-0-1-4.eu-west-1.compute.internal");
    expect(long("ip-10-0-1")).toBeNull();

    const short = nodeMatcher(["ip-10-0-1-4"]);
    expect(short("ip-10-0-1-4.eu-west-1.compute.internal")).toBe("ip-10-0-1-4");
    expect(short("ip-10-0-1-40.eu-west-1.compute.internal")).toBeNull();
  });

  /** `node1` could be either data centre's; guessing draws one node's usage on the other. */
  it("matches a short name two nodes begin with to neither", () => {
    const of = nodeMatcher(["node1.dc1.example", "node1.dc2.example"]);
    expect(of("node1")).toBeNull();
    expect(of("node1.dc2.example")).toBe("node1.dc2.example");
    expect(of("node1.dc2")).toBe("node1.dc2.example");
  });
});
