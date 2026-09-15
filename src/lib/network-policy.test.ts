import { describe, expect, it } from "vitest";

import type { PolicyDirection, PolicyPeer } from "@/generated/types";
import {
  directionFact,
  namespacesOf,
  podsOf,
  portText,
  reachOf,
  verdictOf,
  type DirectionVerdict,
} from "./network-policy";

const direction = (over: Partial<PolicyDirection>): PolicyDirection => ({
  governed: true,
  rules: [],
  opensToEverything: false,
  deniesEverything: false,
  ...over,
});

/** A translator that hands back the key, so a test asserts which was chosen. */
const say = ((_section: string, key: string, values?: { n?: number }) =>
  values?.n === undefined ? key : `${key}:${values.n}`) as never;

const peer = (over: Partial<PolicyPeer>): PolicyPeer => ({
  pods: { kind: "notSaid" },
  namespaces: { kind: "notSaid" },
  ipBlock: null,
  ...over,
});

describe("what a policy does in one direction", () => {
  /**
   * The pair that costs one character in YAML. `ingress: []` on a governed
   * direction denies everything; `ingress: [{}]` allows everything. A column
   * that counted rules would print 0 and 1 and let the reader guess which
   * way round it is.
   */
  it("tells a direction with no rules from one whose rule names no peers", () => {
    expect(verdictOf(direction({ rules: [] }))).toBe("deniesEverything");
    expect(
      verdictOf(
        direction({
          rules: [{ peers: [], ports: [] }],
          opensToEverything: true,
        })
      )
    ).toBe("opensToEverything");
  });

  /**
   * A direction outside `policyTypes` is one this policy says nothing about,
   * and another policy in the namespace may govern it. Reading it as denied
   * turns an ingress-only policy into a claim about egress nobody made.
   */
  it("does not read silence about a direction as a closed one", () => {
    expect(verdictOf(direction({ governed: false, rules: [] }))).toBe(
      "notGoverned"
    );
  });

  /**
   * A rule with no peers but with ports lets traffic through from anywhere
   * *on those ports*, which is a restriction. Reading peers alone summarised
   * "out to 5432 and nothing else" as "allows all", in warn amber, on the
   * column people scan the list with.
   */
  it("does not call a direction open because one rule named no peer", () => {
    expect(
      verdictOf(
        direction({
          rules: [
            {
              peers: [],
              ports: [{ protocol: "TCP", port: "5432", endPort: null }],
            },
          ],
          opensToEverything: false,
        })
      )
    ).toBe("restricts");
  });

  it("says a direction with real rules restricts rather than opens", () => {
    expect(
      verdictOf(
        direction({
          rules: [
            {
              peers: [peer({ pods: { kind: "written", query: "a=b" } })],
              ports: [],
            },
          ],
        })
      )
    ).toBe("restricts");
  });

  /**
   * The map from verdict to what the row shows is exhaustive by type, so a
   * fifth verdict cannot be added without every render site being told. This
   * asserts the set itself, which is what the compiler checks against.
   */
  it("has four answers and no fallback", () => {
    const drawn: Record<DirectionVerdict, string> = {
      notGoverned: "—",
      deniesEverything: "denies all",
      opensToEverything: "allows all",
      restricts: "rules",
    };
    expect(Object.keys(drawn).sort()).toEqual([
      "deniesEverything",
      "notGoverned",
      "opensToEverything",
      "restricts",
    ]);
  });
});

describe("how many pods a policy is actually in front of", () => {
  /**
   * The third state. A refused pod list arrives as `null`, and zero is a
   * real finding — a policy selecting nothing protects nothing. Collapsing
   * the two would report the finding to every reader without `list pods`.
   */
  it("keeps a pod list nobody could read apart from an empty one", () => {
    expect(reachOf(null)).toEqual({ kind: "cannotSay" });
    expect(reachOf(0)).toEqual({ kind: "nothing" });
    expect(reachOf(3)).toEqual({ kind: "pods", count: 3 });
  });
});

describe("the two selectors inside one peer", () => {
  /**
   * The same three shapes mean opposite things on the two axes. An absent
   * `namespaceSelector` is this policy's own namespace, the narrowest peer
   * there is; an absent `podSelector` is every pod, the widest. One renderer
   * over `PolicySelects` would get one of them backwards.
   */
  it("reads an absent selector wide on one axis and narrow on the other", () => {
    expect(namespacesOf({ kind: "notSaid" })).toEqual({ kind: "ownNamespace" });
    expect(namespacesOf({ kind: "everything" })).toEqual({
      kind: "everyNamespace",
    });
    expect(podsOf({ kind: "notSaid" })).toEqual({ kind: "everyPod" });
    expect(podsOf({ kind: "everything" })).toEqual({ kind: "everyPod" });
  });
});

describe("the words each direction is given", () => {
  /**
   * The list, the detail page and the peek panel all call this, which is the
   * point: the same policy drawn by three surfaces used to be three chances
   * to phrase "governs nothing" as "denies everything". Fails if a verdict
   * stops carrying its tone or its words.
   */
  it("gives the open direction a tone and the silent one none", () => {
    expect(
      directionFact(
        {
          governed: true,
          rules: [],
          opensToEverything: false,
          deniesEverything: true,
        },
        say
      )
    ).toEqual({ value: "deniesAll" });
    expect(
      directionFact(
        {
          governed: true,
          rules: [{ peers: [], ports: [] }],
          opensToEverything: true,
          deniesEverything: false,
        },
        say
      )
    ).toEqual({ value: "allowsAll", tone: "warn" });
    expect(
      directionFact(
        {
          governed: false,
          rules: [],
          opensToEverything: false,
          deniesEverything: false,
        },
        say
      )
    ).toEqual({ value: "saysNothing" });
  });
});

describe("how a port is written", () => {
  /**
   * `endPort` turns one port into a range, and a renderer that printed only
   * `port` would say a policy opens 8000 when it opens 8000 through 8100.
   */
  it("keeps a range a range and a named port its name", () => {
    expect(
      portText({ protocol: "TCP", port: "5432", endPort: null }, say)
    ).toBe("TCP/5432");
    expect(
      portText({ protocol: "TCP", port: "8000", endPort: 8100 }, say)
    ).toBe("TCP/8000-8100");
    expect(portText({ protocol: "UDP", port: "dns", endPort: null }, say)).toBe(
      "UDP/dns"
    );
  });

  /**
   * The API server does not fill `port` in, so an entry naming only a
   * protocol arrives with `port: null` and means *every* port of it — the
   * widest thing the entry can say. Printing the field put the literal
   * "null" on the row where the reader needed the opposite of a
   * restriction. Fails if the null case goes back through the template.
   */
  it("says every port of a protocol rather than printing the missing field", () => {
    expect(portText({ protocol: "UDP", port: null, endPort: null }, say)).toBe(
      "everyPortOf"
    );
  });
});
