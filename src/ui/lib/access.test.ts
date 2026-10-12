import { describe, expect, it } from "vite-plus/test";

import { translate } from "@/i18n";
import type { T } from "@/i18n/useT";
import { deniedWords } from "./access";

const t: T = (section, key, values) => translate("en", section, key, values);
const pods = { group: "", resource: "pods", namespace: "team-checkout" };
const command = (words: string) =>
  /kubectl auth can-i (.+)\.$/.exec(words)?.[1];

describe("the can-i command a refusal quotes", () => {
  /**
   * Marco ran the command the Port forward tooltip quoted and got no where
   * the cluster allows it: `pods/portforward` there is a pod named
   * portforward. Fails if a subresource is quoted in that form again.
   */
  it.each(["exec", "portforward", "ephemeralcontainers"])(
    "asks for the %s subresource with --subresource, not as a pod name",
    (subresource) => {
      const words = deniedWords(
        t,
        subresource === "ephemeralcontainers" ? "patch" : "create",
        {
          ...pods,
          subresource,
        }
      );
      expect(command(words)).toMatch(
        new RegExp(
          `^(create|patch) pods --subresource=${subresource} -n team-checkout$`
        )
      );
      expect(words).not.toContain(`pods/${subresource}`);
    }
  );

  /** Fails if a question with no subresource grows a flag, or loses its group or namespace. */
  it("quotes a plain question with its group and namespace", () => {
    expect(command(deniedWords(t, "create", pods))).toBe(
      "create pods -n team-checkout"
    );
    expect(
      command(
        deniedWords(t, "delete", {
          group: "apps",
          resource: "deployments",
          namespace: "team-checkout",
        })
      )
    ).toBe("delete deployments.apps -n team-checkout");
    expect(
      command(
        deniedWords(t, "delete", {
          group: "",
          resource: "nodes",
          namespace: null,
        })
      )
    ).toBe("delete nodes");
  });
});
