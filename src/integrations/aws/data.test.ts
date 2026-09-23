import { describe, expect, it } from "vitest";

import type { IngressClassSummary } from "@/generated/types";
import { CONTROLLER, parametersOf } from "./data";

const cls = (
  parameters: IngressClassSummary["parameters"]
): IngressClassSummary => ({
  name: "alb",
  controller: CONTROLLER,
  isDefault: false,
  parameters,
});

describe("the parameters an ALB class names", () => {
  /**
   * An IngressClass may point `spec.parameters` at any object. Reading some
   * other controller's kind as an `IngressClassParams` would give the class
   * a scheme, subnets and a certificate it never had.
   */
  it("takes only this controller's own kind", () => {
    expect(
      parametersOf(
        cls({
          apiGroup: "elbv2.k8s.aws",
          kind: "IngressClassParams",
          name: "internet-facing",
          scope: null,
          namespace: null,
        })
      )
    ).toBe("internet-facing");
    expect(
      parametersOf(
        cls({
          apiGroup: "example.com",
          kind: "GatewayConfig",
          name: "internet-facing",
          scope: null,
          namespace: null,
        })
      )
    ).toBeNull();
    expect(parametersOf(cls(null))).toBeNull();
  });
});
