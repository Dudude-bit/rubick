import { describe, expect, it } from "vitest";

import { translate } from "@/i18n";
import type { T } from "@/i18n/useT";

import { reportOf } from "./report";

const t: T = (section, key, values) => translate("en", section, key, values);

describe("what an AzureIdentityBinding tells a reader with no cluster access", () => {
  it("names the identity and the pod selector, as the whole object says in one line", () => {
    const sections = reportOf(
      {
        group: "aadpodidentity.k8s.io",
        kind: "AzureIdentityBinding",
        namespace: "shop",
        name: "web-binding",
        spec: { azureIdentity: "web-identity", selector: "web" },
        status: {},
      },
      t
    );
    if (sections?.[0]?.body.type !== "facts") throw new Error("expected facts");
    const rows = sections[0].body.rows;
    expect(rows[0]?.values[0]?.text).toBe("web-identity");
    expect(rows[0]?.values[0]?.ref?.kind).toBe("AzureIdentity");
    expect(rows[1]?.values[0]?.text).toBe("aadpodidbinding=web");
  });
});

describe("what an AzureIngressProhibitedTarget tells a reader with no cluster access", () => {
  it("names the hostname and paths AGIC is told to leave alone", () => {
    const sections = reportOf(
      {
        group: "appgw.ingress.k8s.io",
        kind: "AzureIngressProhibitedTarget",
        namespace: "shop",
        name: "legacy",
        spec: { hostname: "legacy.example.com", paths: ["/old"] },
        status: {},
      },
      t
    );
    if (sections?.[0]?.body.type !== "facts") throw new Error("expected facts");
    expect(sections[0].body.rows[0]?.values[0]?.text).toBe(
      "legacy.example.com · /old"
    );
  });
});

describe("what an object of another vendor's kind gets", () => {
  it("declines an IngressClassParams: that is the AWS Load Balancer Controller's kind", () => {
    const sections = reportOf(
      {
        group: "elbv2.k8s.aws",
        kind: "IngressClassParams",
        namespace: "shop",
        name: "web",
        spec: {},
        status: {},
      },
      t
    );
    expect(sections).toBeNull();
  });
});
