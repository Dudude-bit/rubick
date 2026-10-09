import { describe, expect, it } from "vite-plus/test";

import type { BindingInfo } from "@/generated/types";
import type { T } from "@/i18n/useT";
import { escalatingVerbs, grantsTo, rulesTable, type Rule } from "./rbac";

const t = ((_section: string, key: string) => key) as T;

const rule = (partial: Partial<Rule>): Rule => ({
  apiGroups: [""],
  resources: [],
  resourceNames: [],
  nonResourceURLs: [],
  verbs: [],
  ...partial,
});

const marco = { name: "marco", namespace: "team-checkout" };

const bound = (
  subjects: BindingInfo["subjects"],
  namespace: string | null = "team-checkout"
): BindingInfo => ({
  kind: namespace ? "RoleBinding" : "ClusterRoleBinding",
  name: "b",
  namespace,
  roleRef: { kind: "ClusterRole", name: "view" },
  subjects,
});

describe("which bindings reach a ServiceAccount", () => {
  /** The API server reads a namespaceless account subject in the binding's namespace. */
  it("names it by account, by its user name, or through its groups", () => {
    const reach = (
      subject: BindingInfo["subjects"][number],
      ns?: string | null
    ) => grantsTo([bound([subject], ns)], marco)[0]?.reach ?? null;
    expect(
      reach({ kind: "ServiceAccount", name: "marco", namespace: null })
    ).toBe("account");
    expect(
      reach({
        kind: "User",
        name: "system:serviceaccount:team-checkout:marco",
        namespace: null,
      })
    ).toBe("account");
    expect(
      reach(
        {
          kind: "Group",
          name: "system:serviceaccounts:team-checkout",
          namespace: null,
        },
        null
      )
    ).toBe("namespaceGroup");
    expect(
      reach({ kind: "Group", name: "system:serviceaccounts", namespace: null })
    ).toBe("everyAccount");
    expect(
      reach({ kind: "Group", name: "system:authenticated", namespace: null })
    ).toBe("authenticated");
  });

  /** A namesake in another namespace is another identity. */
  it("does not take an account of the same name elsewhere for it", () => {
    expect(
      grantsTo(
        [
          bound([
            { kind: "ServiceAccount", name: "marco", namespace: "tools" },
          ]),
          bound(
            [
              {
                kind: "Group",
                name: "system:serviceaccounts:tools",
                namespace: null,
              },
            ],
            null
          ),
          bound([{ kind: "User", name: "marco", namespace: null }]),
        ],
        marco
      )
    ).toEqual([]);
  });

  it("puts the most direct grant first", () => {
    const grants = grantsTo(
      [
        bound([
          { kind: "Group", name: "system:authenticated", namespace: null },
        ]),
        bound([
          { kind: "Group", name: "system:serviceaccounts", namespace: null },
          { kind: "ServiceAccount", name: "marco", namespace: "team-checkout" },
        ]),
      ],
      marco
    );
    expect(grants.map((grant) => grant.reach)).toEqual([
      "account",
      "authenticated",
    ]);
  });
});

describe("verbs that grant more than they name", () => {
  /** The three verbs Kubernetes documents as privilege escalation, and * on secrets. */
  it("marks escalate, bind, impersonate and * over secrets", () => {
    expect(
      escalatingVerbs(
        rule({
          apiGroups: ["rbac.authorization.k8s.io"],
          verbs: ["bind", "escalate", "get"],
        })
      )
    ).toEqual(["bind", "escalate"]);
    expect(
      escalatingVerbs(rule({ resources: ["users"], verbs: ["impersonate"] }))
    ).toEqual(["impersonate"]);
    expect(
      escalatingVerbs(rule({ resources: ["secrets"], verbs: ["*"] }))
    ).toEqual(["*"]);
    expect(
      escalatingVerbs(
        rule({ apiGroups: ["*"], resources: ["*"], verbs: ["*"] })
      )
    ).toEqual(["*"]);
  });

  /** * on pods is broad, and amber; it is not a way to more rights than it says. */
  it("leaves * over other kinds and reads of secrets unmarked", () => {
    expect(
      escalatingVerbs(rule({ resources: ["pods"], verbs: ["*"] }))
    ).toEqual([]);
    expect(
      escalatingVerbs(rule({ resources: ["secrets"], verbs: ["get"] }))
    ).toEqual([]);
    expect(
      escalatingVerbs(
        rule({ apiGroups: ["apps"], resources: ["*"], verbs: ["*"] })
      )
    ).toEqual([]);
  });

  it("carries the mark into the verbs cell of the rules table", () => {
    const table = rulesTable(
      [
        rule({ resources: ["secrets"], verbs: ["*"] }),
        rule({ resources: ["pods"], verbs: ["get"] }),
      ],
      t
    );
    expect(table.rows[0][3]).toEqual({ words: ["*"], escalating: ["*"] });
    expect(table.rows[1][3]).toEqual({ words: ["get"] });
  });
});
