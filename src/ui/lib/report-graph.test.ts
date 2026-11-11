import { describe, expect, it } from "vite-plus/test";

import type { ObjectRef, ResourceConnections } from "@/generated/types";
import { translate } from "@/i18n";
import type { T } from "@/i18n/useT";
import type { IngressClaim } from "./ingress-health";
import { trafficOf } from "./report-graph";

const t: T = (section, key, values) => translate("en", section, key, values);

const ref = (kind: string, name: string): ObjectRef => ({
  kind,
  name,
  namespace: "shop",
  existence: "present",
  facts: null,
});

const conns: ResourceConnections = {
  subject: ref("Pod", "web-1"),
  edges: [
    {
      from: ref("Service", "web"),
      to: ref("Pod", "web-1"),
      relation: { verb: "selects", selector: "app=web" },
    },
    {
      from: ref("Ingress", "web"),
      to: ref("Service", "web"),
      relation: {
        verb: "routes",
        host: "web.example.com",
        path: "/",
        pathType: "Prefix",
        port: "80",
        tls: false,
      },
    },
  ],
  stops: [],
  published: [],
  notLookedAt: [],
};

const controllerHop = (claim: IngressClaim, classless?: string[]) =>
  trafficOf(conns, t, {
    routing: new Map([
      [
        "Ingress/shop/web",
        {
          tls: [],
          addresses: claim === "address" ? ["34.1.2.3"] : [],
          binding: {
            requested: classless ? null : "gce",
            resolved: claim === "class" ? "gce" : null,
            controller: claim === "class" ? "example.com/gce" : null,
            viaDefault: false,
            available: [],
            claim,
            classless,
          },
        },
      ],
    ]),
  })
    .flatMap((path) => path.hops)
    .find((hop) => hop.text?.includes(classless ? "names no class" : "gce"));

describe("the controller hop of a shared traffic path", () => {
  /**
   * The file named "IngressClass gce" in red for a class only the
   * annotation names, where no such IngressClass exists to be missing.
   * Fails if a claim the cluster does not record is filed as refused, or
   * goes out with no warning: in a file "not known" stays for good.
   */
  it("says a claim the cluster does not record in its own words, warned and never refused", () => {
    expect(controllerHop("unrecorded")).toMatchObject({
      text: "Class gce, named by the kubernetes.io/ingress.class annotation: no IngressClass has that name",
      detail: expect.stringContaining("is not known"),
      tone: "warn",
    });
    expect(controllerHop("address")).toMatchObject({
      detail: expect.stringContaining("has published its address"),
      tone: null,
    });
    expect(controllerHop("none")).toMatchObject({
      text: "IngressClass gce",
      tone: "err",
    });
    expect(controllerHop("class")).toMatchObject({
      text: "IngressClass gce",
      detail: "example.com/gce",
      tone: null,
    });
  });

  /**
   * An Ingress that names no class has no annotation to match. Fails if the
   * file prints the annotation's sentence under it, or drops who was found.
   */
  it("says who may take an Ingress that names no class", () => {
    expect(controllerHop("unrecorded", ["Traefik"])).toMatchObject({
      text: "This Ingress names no class, and this cluster has no default one",
      detail: expect.stringContaining("Installed here: Traefik."),
      tone: "warn",
    });
  });
});
