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
    expect(hostTls(false, null, true)).toBeNull();
    expect(hostTls(false, null, false)).toBe(false);
  });
});
