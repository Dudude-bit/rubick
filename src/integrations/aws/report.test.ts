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
