import { describe, expect, it } from "vite-plus/test";

import type { IngressTls } from "@/integrations";
import { hostTls } from "./ingress-tls";

const said = (
  terminated: IngressTls["terminated"],
  replacesSpec?: boolean
): IngressTls => ({
  host: "shop.example.com",
  terminated,
  by: { key: "awsHttpOnly" },
  replacesSpec,
});

describe("whether an Ingress host is served over TLS", () => {
  /** A cloud certificate in an annotation adds to spec.tls; its "no" takes nothing away. */
  it("keeps spec.tls over a controller that only adds to it", () => {
    expect(hostTls(true, said(false), false)).toBe(true);
    expect(hostTls(false, said(true), false)).toBe(true);
  });

  /** Traefik reads spec.tls for certificates only, so its word is the answer. */
  it("takes the word of a controller whose answer replaces spec.tls", () => {
    expect(hostTls(true, said(false, true), false)).toBe(false);
    expect(hostTls(true, said(null, true), false)).toBeNull();
  });

  /** A question still out, or one that failed, has not said no. */
  it("leaves a host spec.tls does not name unknown while nobody has answered", () => {
    expect(hostTls(false, null, "adds")).toBeNull();
    expect(hostTls(false, null, false)).toBe(false);
  });

  /**
   * A Traefik Ingress with spec.tls read as HTTPS while Traefik's answer was
   * out or its read had failed, and stayed HTTPS after a failure. Fails if
   * spec.tls decides before the controller that replaces it has spoken, or
   * if a missing answer that could only add to it takes the field away.
   */
  it("lets spec.tls settle nothing while the controller that replaces it is silent", () => {
    expect(hostTls(true, null, "replaces")).toBeNull();
    expect(hostTls(true, said(true), "replaces")).toBeNull();
    expect(hostTls(true, said(false, true), "replaces")).toBe(false);
    expect(hostTls(true, null, "adds")).toBe(true);
  });
});
