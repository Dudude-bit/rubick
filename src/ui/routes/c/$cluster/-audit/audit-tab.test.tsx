import { describe, expect, it } from "vite-plus/test";
import { screen } from "@testing-library/react";

import type { ObjectAudit } from "@/generated/types";
import { translate } from "@/i18n";
import type { T } from "@/i18n/useT";
import { renderWithRouter } from "@/test/render";
import { auditMark } from "./audit-tab";
import { PeekAudit } from "./PeekAudit";
import type { ObjectAuditQuery } from "./useAudit";

const t: T = (section, key, values) => translate("en", section, key, values);

const audit = (over: Partial<ObjectAudit> = {}): ObjectAudit => ({
  subject: { kind: "Deployment", namespace: "shop", name: "web" },
  system: false,
  findings: [],
  unchecked: [],
  judgedOn: null,
  ...over,
});

const unchecked = {
  rule: "no-disruption-budget" as const,
  kind: "PodDisruptionBudget",
  namespace: "shop",
  why: { says: "refused" as const, message: "forbidden" },
};

const query = (data: ObjectAudit | undefined) =>
  ({
    data,
    error: null,
    refetch: () => undefined,
  }) as unknown as ObjectAuditQuery;

describe("the Audit tab's mark", () => {
  /**
   * A tab whose rules could not answer is not a clean tab. Fails if it shows
   * nothing, or a count of zero, where its body says "not checked".
   */
  it("marks a tab with nothing found and a rule unanswered as not checked", () => {
    expect(auditMark(audit({ unchecked: [unchecked] }), null, t)).toEqual({
      shows: "unchecked",
      says: "Not checked here",
    });
    expect(auditMark(undefined, new Error("forbidden"), t)?.shows).toBe(
      "unchecked"
    );
  });

  /** Fails if a high finding is drawn as a plain count. */
  it("takes its tone from the worst finding, and counts the low ones", () => {
    const high = audit({
      findings: [{ rule: "pss-privileged", severity: "high", what: [] }],
    });
    expect(auditMark(high, null, t)).toMatchObject({
      shows: "severity",
      tone: "err",
    });
    const low = audit({
      findings: [{ rule: "no-liveness-probe", severity: "low", what: [] }],
    });
    expect(auditMark(low, null, t)).toEqual({ shows: "count", of: 1 });
    expect(auditMark(audit(), null, t)).toBeNull();
  });
});

describe("a pod judged as part of its workload", () => {
  /**
   * A pod a Deployment stamps out is judged once, on the Deployment. Fails
   * if its page says nothing was found instead of where it was judged.
   */
  it("says which workload it is judged on, and links to it", async () => {
    await renderWithRouter(
      <PeekAudit
        query={query(
          audit({
            subject: { kind: "Pod", namespace: "shop", name: "web-7d9f-x" },
            judgedOn: { kind: "Deployment", namespace: "shop", name: "web" },
          })
        )}
      />,
      {
        at: "/c/prod/pods/shop/web-7d9f-x",
        route: "/c/$cluster/pods/$namespace/$name",
      }
    );
    const line = screen.getByTestId("audit-judged-on");
    expect(line).toHaveTextContent(/This Pod's template is judged as part of/);
    expect(line.querySelector("a")).toHaveAttribute(
      "href",
      "/c/prod/deployments/shop/web"
    );
    expect(screen.queryByText("Nothing found")).toBeNull();
  });
});
