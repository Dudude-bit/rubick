import { describe, expect, it } from "vitest";

import { translate } from "@/i18n";
import type { T } from "@/i18n/useT";

import { reportOf } from "./report";

const t: T = (section, key, values) => translate("en", section, key, values);

describe("what a TargetGroupBinding tells a reader with no cluster access", () => {
  it("names the Service, the target group and the controller's own failure", () => {
    const sections = reportOf(
      {
        group: "elbv2.k8s.aws",
        kind: "TargetGroupBinding",
        namespace: "shop",
        name: "web",
        spec: {
          serviceRef: { name: "web", port: 80 },
          targetGroupARN:
            "arn:aws:elasticloadbalancing:us-east-1:1234:targetgroup/web-tg/abc123",
          targetType: "ip",
        },
        status: {
          conditions: [
            {
              type: "Ready",
              status: "False",
              message: "target group not found",
            },
          ],
        },
      },
      t
    );
    if (sections?.[0]?.body.type !== "facts") throw new Error("expected facts");
    const rows = sections[0].body.rows;
    expect(rows[0]).toEqual({
      label: "Status",
      values: [{ text: "target group not found", role: "err" }],
    });
    expect(rows[1]?.values[0]?.text).toBe("web:80");
    expect(rows[1]?.values[0]?.ref?.kind).toBe("Service");
    expect(rows[2]?.values[0]?.text).toBe("web-tg");
  });
});

describe("a TargetGroupBinding the controller has said nothing about", () => {
  const status = (status: unknown) => {
    const sections = reportOf(
      {
        group: "elbv2.k8s.aws",
        kind: "TargetGroupBinding",
        namespace: "shop",
        name: "web",
        spec: { serviceRef: { name: "web", port: 80 } },
        status,
      },
      t
    );
    if (sections?.[0]?.body.type !== "facts") throw new Error("expected facts");
    return sections[0].body.rows[0].values[0];
  };

  /** No status at all read as "nothing the controller has flagged", which is
   *  a verdict the controller never gave. */
  it("says no status is written yet, not that nothing is flagged", () => {
    expect(status({})).toEqual({ text: "not written yet", quiet: true });
  });

  /** `Ready=False` with no message or reason was filed under "nothing flagged". */
  it("reports Ready=False as a failure even when the controller gave no words", () => {
    expect(
      status({ conditions: [{ type: "Ready", status: "False" }] })
    ).toEqual({ text: "Ready=False", role: "err" });
  });

  it("says nothing is flagged only once Ready is True", () => {
    expect(status({ conditions: [{ type: "Ready", status: "True" }] })).toEqual(
      { text: "nothing the controller has flagged", quiet: true }
    );
  });
});

describe("what an object of another vendor's kind gets", () => {
  it("declines a BackendConfig: that is GKE Ingress's kind, not the AWS controller's", () => {
    const sections = reportOf(
      {
        group: "cloud.google.com",
        kind: "BackendConfig",
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
