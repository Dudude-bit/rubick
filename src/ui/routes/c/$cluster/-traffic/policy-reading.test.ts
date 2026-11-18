import { describe, expect, it } from "vite-plus/test";

import type {
  FlowEnd,
  NetworkPolicyInfo,
  PolicyDirection,
  PolicyPeer,
} from "@/generated/types";
import { translate } from "@/i18n";
import type { T } from "@/i18n/useT";
import type { Known } from "@/lib/known";
import type { LabeledNamespace, PolicyRows } from "@/lib/policy-peers";
import {
  podsOfEnd,
  policyReading,
  rowsIn,
  type WorkloadPod,
} from "./policy-reading";
import { readingWords } from "./traffic-words";

const t: T = (section, key, values) => translate("en", section, key, values);

const direction = (
  governed: boolean,
  peers: PolicyPeer[] = []
): PolicyDirection => ({
  governed,
  rules: peers.length > 0 ? [{ peers, ports: [] }] : [],
  opensToEverything: false,
  deniesEverything: governed && peers.length === 0,
});

const from = (query: string): PolicyPeer => ({
  pods: { kind: "written", query },
  namespaces: { kind: "notSaid" },
  ipBlock: null,
});

/** The stand's policy: db takes connections from caller and nothing else. */
const DB_FROM_CALLER: NetworkPolicyInfo = {
  uid: "",
  name: "db-from-caller-only",
  namespace: "shop",
  selects: { kind: "written", query: "app=db" },
  selected: 1,
  nearly: null,
  ingress: direction(true, [from("app=caller")]),
  egress: direction(false),
  labels: {},
  createdAt: null,
};

const pod = (app: string): WorkloadPod => ({
  name: `${app}-7d9f-x`,
  namespace: "shop",
  labels: { app },
  workload: { kind: "Deployment", name: app },
});
const DB = [pod("db")];
const CALLER = [pod("caller")];
const INTRUDER = [pod("intruder")];

const rows = (policies: NetworkPolicyInfo[]): PolicyRows => ({
  known: true,
  value: { rows: policies, unreadHere: null },
});
const NAMESPACES: Known<LabeledNamespace[]> = {
  known: true,
  value: [{ name: "shop", labels: {} }],
};

const read = (
  source: WorkloadPod[],
  target: WorkloadPod[],
  policies: PolicyRows
) =>
  policyReading({
    from: source,
    to: target,
    toPolicies: policies,
    fromPolicies: policies,
    namespaces: NAMESPACES,
  });

describe("the app's reading of the policies on a drop Hubble named none for", () => {
  /**
   * The intruder falls to the default deny of a policy that admits only the
   * caller: Hubble names no policy, the app's reading names the one that
   * selects db and says none of its rules admits the intruder.
   */
  it("names the policy that selects the destination and admits no rule for the source", () => {
    expect(read(INTRUDER, DB, rows([DB_FROM_CALLER]))).toEqual({
      says: "noRuleAdmits",
      direction: "ingress",
      policies: ["db-from-caller-only"],
    });
    expect(read(CALLER, DB, rows([DB_FROM_CALLER]))).toMatchObject({
      says: "unsettled",
    });
    expect(read(INTRUDER, DB, rows([]))).toEqual({ says: "notSelected" });
  });

  /** The source's egress is the other place a connection is held. */
  it("reads the source's egress where the destination's ingress lets it through", () => {
    const outOnlyToWeb: NetworkPolicyInfo = {
      ...DB_FROM_CALLER,
      name: "intruder-out-to-web",
      selects: { kind: "written", query: "app=intruder" },
      ingress: direction(false),
      egress: direction(true, [from("app=web")]),
    };
    expect(read(INTRUDER, DB, rows([outOnlyToWeb]))).toEqual({
      says: "noRuleAdmits",
      direction: "egress",
      policies: ["intruder-out-to-web"],
    });
  });

  /**
   * The policies listed and one namespace's refused: that namespace's empty
   * rows are not "no policy". Fails if `rowsIn` drops the refusal it was
   * handed for the namespace it is asked about.
   */
  it("says the policies could not be read where the list answered and the end's namespace was refused", () => {
    const listed = rowsIn(
      {
        known: true,
        value: {
          rows: [],
          unread: [
            {
              namespace: "shop",
              code: "FORBIDDEN",
              message: "networkpolicies is forbidden in shop",
            },
          ],
        },
      },
      "shop"
    );
    expect(read(INTRUDER, DB, listed)).toEqual({
      says: "unread",
      why: "networkpolicies is forbidden in shop",
    });
  });

  /**
   * A rule that names addresses, or a selector Kubernetes would not build,
   * cannot be settled from labels: never "no rule admits it".
   */
  it("leaves a rule of addresses or of a selector it cannot evaluate unsettled", () => {
    const ruled = (peer: PolicyPeer) =>
      read(
        INTRUDER,
        DB,
        rows([{ ...DB_FROM_CALLER, ingress: direction(true, [peer]) }])
      );
    expect(
      ruled({
        pods: { kind: "notSaid" },
        namespaces: { kind: "notSaid" },
        ipBlock: { cidr: "10.0.0.0/8", except: [] },
      })
    ).toMatchObject({ says: "unsettled", direction: "ingress" });
    expect(ruled(from("app in ("))).toMatchObject({ says: "unsettled" });
  });

  /** An end with no pods read has nothing to read policies over. */
  it("says it could not read where an end has no pods to read", () => {
    expect(read([], DB, rows([DB_FROM_CALLER]))).toEqual({
      says: "unread",
      why: null,
    });
  });

  /** A refused list is "could not read", never "no policy holds it". */
  it("says the policies could not be read where they or the namespaces were refused", () => {
    expect(
      read(INTRUDER, DB, {
        known: false,
        why: "networkpolicies is forbidden",
      })
    ).toEqual({ says: "unread", why: "networkpolicies is forbidden" });
    const byNamespace: NetworkPolicyInfo = {
      ...DB_FROM_CALLER,
      ingress: direction(true, [
        {
          pods: { kind: "everything" },
          namespaces: { kind: "written", query: "team=ops" },
          ipBlock: null,
        },
      ]),
    };
    expect(
      policyReading({
        from: INTRUDER,
        to: DB,
        toPolicies: rows([byNamespace]),
        fromPolicies: rows([byNamespace]),
        namespaces: { known: false, why: "namespaces is forbidden" },
      })
    ).toEqual({ says: "unread", why: "namespaces is forbidden" });
  });

  /** An end is its workload's pods, a CronJob's runs, or the pod itself; anything else has none. */
  it("finds an end's pods by the workload the pod list files them under", () => {
    const end = (kind: string, name: string): FlowEnd => ({
      is: "workload",
      key: { namespace: "shop", group: "apps", kind, name },
    });
    const run: WorkloadPod = {
      ...pod("backup"),
      workload: { kind: "Job", name: "backup-28473000" },
    };
    expect(podsOfEnd(end("Deployment", "db"), [...DB, ...CALLER])).toEqual(DB);
    expect(podsOfEnd(end("CronJob", "backup"), [run, ...DB])).toEqual([run]);
    expect(podsOfEnd(end("Pod", "db-7d9f-x"), DB)).toEqual(DB);
    expect(podsOfEnd({ is: "address", address: "1.2.3.4" }, DB)).toBeNull();
  });

  /** What it could not settle, and could not read with or without the cluster's words, each said as such. */
  it("says an unsettled rule and an unread path in their own words", () => {
    const db = {
      namespace: "shop",
      group: "apps",
      kind: "Deployment",
      name: "db",
    };
    const intruder = { ...db, name: "intruder" };
    const said = (reading: Parameters<typeof readingWords>[0]) =>
      readingWords(reading, { known: true, value: [] }, intruder, db, t)
        .map((part) => part.text)
        .join(" ");
    expect(
      said({
        says: "unsettled",
        direction: "ingress",
        policies: ["db-from-caller-only"],
      })
    ).toContain("a rule there may admit intruder");
    expect(said({ says: "unread", why: null })).toContain(
      "The NetworkPolicies on this path could not be read."
    );
    expect(said({ says: "unread", why: "pods is forbidden" })).toContain(
      "could not be read: pods is forbidden"
    );
  });

  /** Said as the app's reading, with the other engines it does not read. */
  it("says the reading as the app's, and the engines it does not read", () => {
    const db = {
      namespace: "shop",
      group: "apps",
      kind: "Deployment",
      name: "db",
    };
    const intruder = { ...db, name: "intruder" };
    expect(
      readingWords(
        {
          says: "noRuleAdmits",
          direction: "ingress",
          policies: ["db-from-caller-only"],
        },
        { known: true, value: [] },
        intruder,
        db,
        t
      )
        .map((part) => part.text)
        .join(" ")
    ).toBe(
      "The app's reading of the NetworkPolicies, not Hubble's: db is selected by NetworkPolicy shop/db-from-caller-only; none of its rules admits intruder."
    );
    expect(
      readingWords(
        { says: "notSelected" },
        { known: true, value: ["CiliumNetworkPolicy"] },
        intruder,
        db,
        t
      ).at(-1)?.text
    ).toBe(
      "Policies of kind CiliumNetworkPolicy also apply here, and the app does not read them."
    );
    expect(
      readingWords(
        { says: "notSelected" },
        { known: false, why: "forbidden" },
        intruder,
        db,
        t
      ).at(-1)?.text
    ).toBe(
      "Whether another engine's policies apply here could not be read: forbidden"
    );
  });
});
