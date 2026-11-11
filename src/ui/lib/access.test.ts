import { readFileSync } from "node:fs";
import { describe, expect, it } from "vite-plus/test";

import { translate } from "@/i18n";
import type { T } from "@/i18n/useT";
import { CODE_FILES } from "@/test/source-files";
import { deniedWords } from "./access";

const t: T = (section, key, values) => translate("en", section, key, values);
const pods = {
  group: "",
  resource: "pods",
  namespace: "team-checkout",
  name: null,
};
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
          name: null,
        })
      )
    ).toBe("delete deployments.apps -n team-checkout");
    expect(
      command(
        deniedWords(t, "delete", {
          group: "",
          resource: "nodes",
          namespace: null,
          name: null,
        })
      )
    ).toBe("delete nodes");
  });

  /**
   * The question the app asked names the object, so the command it quotes
   * must too. Fails if the name is dropped: the reader would run a nameless
   * question and get a "no" the cluster does not give for this object.
   */
  it("names the object the question was about, as resource/name", () => {
    expect(
      command(
        deniedWords(t, "create", {
          ...pods,
          name: "web-0",
          subresource: "portforward",
        })
      )
    ).toBe("create pods/web-0 --subresource=portforward -n team-checkout");
  });
});

describe("who asks the authorizer", () => {
  /**
   * The command takes the object's name as an optional field, so a caller
   * that forgets it asks about every object, and a grant on one named
   * object reads as a refusal: CNPG and Scylla did. `askAccess` takes an
   * `Asked`, whose name has to be stated. Fails if a file asks on its own.
   */
  it("is this module alone, where a question has to state its name", () => {
    const asking = CODE_FILES.filter(
      (path) =>
        path !== "src/ui/lib/access.ts" &&
        !path.startsWith("src/ui/generated/") &&
        /\.checkAccess\b/.test(readFileSync(path, "utf8"))
    );
    expect(CODE_FILES.length).toBeGreaterThan(500);
    expect(asking).toEqual([]);
  });
});
