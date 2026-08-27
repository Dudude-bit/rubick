import { describe, expect, it } from "vitest";

import type { CustomResourceInfo } from "@/generated/types";
import { bindingFailure, bindingSummary, targetGroupLabel } from "./model";

import { translate } from "@/i18n";
import { joinSayings } from "@/i18n/say";
import type { T } from "@/i18n/useT";

/** The English catalogue — what these expectations are written in. */
const t: T = (section, key, values) => translate("en", section, key, values);

const binding = (
  spec: unknown,
  status: unknown = null
): CustomResourceInfo => ({
  name: "specimen",
  namespace: "k8s-gui-test",
  uid: "0",
  apiVersion: "elbv2.k8s.aws/v1beta1",
  kind: "TargetGroupBinding",
  spec,
  status,
  labels: {},
  annotations: {},
  createdAt: null,
  ownerReferences: [],
});

const ARN =
  "arn:aws:elasticloadbalancing:eu-west-1:123456789012:targetgroup/k8s-shop-web-9f8e7d/0a1b2c3d4e5f6789";

describe("which target group a Service is in", () => {
  it("shortens an ARN to the part a person recognises", () => {
    /** Would break if a chain hop grew an eighty-character ARN. The account
     *  and region in front identify the same group to nobody reading a
     *  hop; the whole ARN is still on the object's own page. */
    expect(targetGroupLabel(binding({ targetGroupARN: ARN }))).toBe(
      "k8s-shop-web-9f8e7d"
    );
  });

  it("prefers the name the object states outright", () => {
    expect(
      targetGroupLabel(
        binding({ targetGroupARN: ARN, targetGroupName: "shop-web" })
      )
    ).toBe("shop-web");
  });

  it("says so when there is no group named at all", () => {
    expect(joinSayings(bindingSummary(binding({})), t)).toBe(
      "no target group named"
    );
  });

  it("puts the group, the target type and the port in one clause", () => {
    expect(
      joinSayings(
        bindingSummary(
          binding({
            targetGroupARN: ARN,
            targetType: "ip",
            serviceRef: { name: "shop-web", port: 80 },
          })
        ),
        t
      )
    ).toBe("k8s-shop-web-9f8e7d · ip · port 80");
  });
});

describe("what the controller complained about", () => {
  it("says nothing at all where the controller wrote no condition", () => {
    /** The case this file exists to get right, and it is the *normal* one.
     *  The AWS controller writes a `Ready` condition only when something
     *  failed, so a healthy binding carries no conditions — identical from
     *  here to a binding on a cluster whose controller is not running.
     *  Reading that silence either way would be inventing a verdict, and
     *  reading it as health is how a broken target group gets drawn green. */
    expect(bindingFailure(binding({}, null))).toBeNull();
    expect(bindingFailure(binding({}, { conditions: [] }))).toBeNull();
    expect(bindingFailure(binding({}, { observedGeneration: 3 }))).toBeNull();
  });

  it("ignores a Ready condition that is not False", () => {
    expect(
      bindingFailure(
        binding({}, { conditions: [{ type: "Ready", status: "True" }] })
      )
    ).toBeNull();
  });

  it("repeats the controller's own sentence rather than paraphrasing it", () => {
    /** Would break if the message were rewritten. "couldn't find target
     *  group" and "AccessDenied" send the reader to two entirely different
     *  places, and a single "not ready" sends them nowhere. */
    expect(
      bindingFailure(
        binding(
          {},
          {
            conditions: [
              {
                type: "Ready",
                status: "False",
                reason: "FailedCleanup",
                message: "TargetGroup not found: k8s-shop-web-9f8e7d",
              },
            ],
          }
        )
      )
    ).toBe("TargetGroup not found: k8s-shop-web-9f8e7d");
  });

  it("falls back to the reason where there is no message", () => {
    expect(
      bindingFailure(
        binding(
          {},
          {
            conditions: [
              { type: "Ready", status: "False", reason: "AccessDenied" },
            ],
          }
        )
      )
    ).toBe("AccessDenied");
  });
});
