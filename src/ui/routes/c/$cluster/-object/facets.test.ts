import { describe, expect, it } from "vite-plus/test";

import { translate } from "@/i18n";
import type { T } from "@/i18n/useT";
import { objectFacets } from "./facets";

/** The key itself, so a group is found by the catalogue key it is titled with. */
const t = ((_section: string, key: string) => key) as never;

const group = (object: unknown, title: string) =>
  objectFacets(object, t).groups.find((g) => g.title === title);

describe("what any object says about itself", () => {
  /** A manager that wrote twice is one writer, as of its latest write. */
  it("names each writer once, with its latest write", () => {
    const writers = group(
      {
        metadata: {
          managedFields: [
            {
              manager: "helm",
              operation: "Update",
              time: "2026-10-01T00:00:00Z",
            },
            {
              manager: "helm",
              operation: "Apply",
              time: "2026-10-03T00:00:00Z",
            },
            {
              manager: "kubectl",
              operation: "Update",
              time: "2026-10-02T00:00:00Z",
            },
          ],
        },
      },
      "writtenBy"
    );
    expect(writers?.items.map((item) => item.label)).toEqual([
      "helm",
      "kubectl",
    ]);
    expect(String(writers?.items[0].value)).toMatch(/^Apply/);
  });

  /** An object nobody wrote fields of has no writers group, not an empty one. */
  it("leaves out the writers of an object with no managed fields", () => {
    expect(group({ metadata: {} }, "writtenBy")).toBeUndefined();
  });

  /** The badge reads a Ready condition when no phase or state was given. */
  it("takes its state from a Ready condition", () => {
    const summary = objectFacets(
      { status: { conditions: [{ type: "Ready", status: "False" }] } },
      t
    );
    expect(summary.status).toBe("Not ready");
  });
});

const titles = (object: unknown) =>
  objectFacets(object, t).groups.map((g) => g.title);

const rows = (object: unknown, title: string) =>
  group(object, title)?.items.map((item) => [item.label, item.value]);

const props = (value: unknown) =>
  (value as { props: Record<string, unknown> }).props;

describe("a kind that keeps what it says at the top level", () => {
  const slice = {
    apiVersion: "discovery.k8s.io/v1",
    kind: "EndpointSlice",
    metadata: { name: "kube-dns-f2mvh", namespace: "kube-system" },
    addressType: "IPv4",
    endpoints: [
      { addresses: ["10.0.0.5"], conditions: { ready: true } },
      { addresses: ["10.0.0.6"], conditions: { ready: false } },
    ],
    ports: [{ name: "dns", port: 53, protocol: "UDP" }],
  };

  /** The reported case: two addresses on screen in YAML, "No spec" above it. */
  it("draws its endpoints and ports instead of saying it has no spec", () => {
    expect(titles(slice)).not.toContain("spec");
    expect(titles(slice)).not.toContain("status");
    expect(rows(slice, "fields")).toEqual([["addressType", "IPv4"]]);
    expect(group(slice, "endpoints")?.count).toBe(2);
    expect(rows(slice, "endpoints")).toContainEqual([
      "1.conditions.ready",
      "false",
    ]);
    expect(rows(slice, "ports")).toContainEqual(["0.port", "53"]);
  });

  /**
   * Sam's `web` slice: twelve rows, then nothing, so the second endpoint read
   * as one with no node and no target pod, and `ports: null`, why the
   * Service had no endpoints, was not on the page at all.
   */
  it("says how many fields it left out and draws a null that is there", () => {
    const endpoint = (ip: string) => ({
      addresses: [ip],
      conditions: { ready: true, serving: true, terminating: false },
      nodeName: "node01",
      targetRef: { kind: "Pod", name: ip, namespace: "net", uid: "u" },
    });
    const web = {
      kind: "EndpointSlice",
      metadata: { name: "web-5dwk4", namespace: "net" },
      addressType: "IPv4",
      endpoints: [endpoint("192.168.1.137"), endpoint("192.168.0.61")],
      ports: null,
    };
    const en: T = (section, key, values) =>
      translate("en", section, key, values);
    const items =
      objectFacets(web, en).groups.find((g) => g.title === "endpoints")
        ?.items ?? [];
    expect(items).toHaveLength(13);
    expect(items.at(-1)).toEqual({
      label: "…",
      value: "6 more fields, in the YAML tab",
    });
    expect(rows(web, "fields")).toContainEqual(["ports", "null"]);
  });

  it("adds no such row when everything fits", () => {
    expect(rows(slice, "endpoints")?.at(-1)).toEqual([
      "1.conditions.ready",
      "false",
    ]);
  });

  it("reads a revision's number and its data", () => {
    const revision = {
      kind: "ControllerRevision",
      metadata: { name: "cache-5d77c77895" },
      revision: 1,
      data: { spec: { template: { $patch: "replace" } } },
    };
    expect(rows(revision, "fields")).toEqual([["revision", "1"]]);
    expect(rows(revision, "data")).toEqual([
      ["spec.template.$patch", "replace"],
    ]);
  });

  /** A Secret reached this way names its keys and never shows their values. */
  it("names a secret's keys without their values", () => {
    const secret = {
      apiVersion: "v1",
      kind: "Secret",
      metadata: { name: "token" },
      data: { password: "aHVudGVyMg==" },
    };
    expect(rows(secret, "data")).toEqual([["password", "••••••"]]);
  });

  /** "No spec" is still the answer for an object that says nothing else. */
  it("says there is no spec only when there is nothing else", () => {
    expect(titles({ metadata: { name: "bare" } })).toEqual(
      expect.arrayContaining(["status", "spec"])
    );
    expect(group({ metadata: {} }, "spec")?.items).toEqual([]);
  });

  /** Unknown is not "none": a kind discovery has not answered for keeps its status line. */
  it("drops the status only of a kind discovery says has none", () => {
    const lease = {
      kind: "Lease",
      metadata: {},
      spec: { holderIdentity: "a" },
    };
    const titlesFor = (hasStatus?: boolean) =>
      objectFacets(lease, t, hasStatus).groups.map((g) => g.title);
    expect(titlesFor(false)).not.toContain("status");
    expect(titlesFor(undefined)).toContain("status");
    expect(titlesFor(true)).toContain("status");
    expect(
      objectFacets({ ...lease, status: { phase: "x" } }, t, false).groups.map(
        (g) => g.title
      )
    ).toContain("status");
  });

  /**
   * Marco's ServiceAccount peek said "Spec: No spec", as if the object had an
   * empty one; the kind has none. Unknown is not "none": a kind discovery has
   * not answered for keeps the line.
   */
  it("says nothing about a spec a kind with no status subresource does not have", () => {
    const account = { kind: "ServiceAccount", metadata: { name: "default" } };
    const titlesFor = (hasStatus?: boolean) =>
      objectFacets(account, t, hasStatus).groups.map((g) => g.title);
    expect(titlesFor(false)).not.toContain("spec");
    expect(titlesFor(undefined)).toContain("spec");
    expect(titlesFor(true)).toContain("spec");
    expect(
      objectFacets(
        { kind: "Lease", metadata: {}, spec: { holderIdentity: "a" } },
        t,
        false
      ).groups.map((g) => g.title)
    ).toContain("spec");
  });

  it("keeps an object's spec and status where it has them", () => {
    const lease = {
      kind: "Lease",
      metadata: { name: "node-1" },
      spec: { holderIdentity: "node-1" },
    };
    expect(titles(lease).slice(0, 2)).toEqual(["status", "spec"]);
    expect(rows(lease, "spec")).toEqual([["holderIdentity", "node-1"]]);
  });

  /** A value that is a whole document folds rather than walls the column. */
  it("folds a long value into a document", () => {
    const config = { metadata: {}, data: { "nginx.conf": "a\nb" } };
    expect(group(config, "data")?.items[0].document).toBe("a\nb");
  });
});

describe("roles and bindings", () => {
  const role = {
    apiVersion: "rbac.authorization.k8s.io/v1",
    kind: "Role",
    metadata: { name: "developer", namespace: "team-checkout" },
    rules: [
      { apiGroups: [""], resources: ["pods", "pods/log"], verbs: ["get"] },
      {
        apiGroups: ["apps"],
        resources: ["deployments"],
        resourceNames: ["web"],
        verbs: ["*"],
      },
    ],
  };

  /** Rules are what a role is for; dotted paths made them unreadable. */
  it("reads a role's rules as a table of what it grants", () => {
    const rules = group(role, "rules");
    expect(rules?.count).toBe(2);
    expect(rules?.table?.columns).toEqual([
      "apiGroups",
      "resources",
      "resourceNames",
      "verbs",
    ]);
    expect(rules?.table?.rows[0]).toEqual([
      { words: ['""'] },
      { words: ["pods", "pods/log"] },
      { words: [], none: "anyName" },
      { words: ["get"] },
    ]);
    expect(rules?.table?.rows[1][2]).toEqual({
      words: ["web"],
      none: "anyName",
    });
  });

  it("adds a column for non-resource URLs only where a rule has them", () => {
    const reader = {
      ...role,
      kind: "ClusterRole",
      rules: [{ nonResourceURLs: ["/healthz"], verbs: ["get"] }],
    };
    const table = group(reader, "rules")?.table;
    expect(table?.columns.at(-1)).toBe("nonResourceURLs");
    expect(table?.rows[0][2]).toEqual({ words: [], none: undefined });
  });

  const binding = {
    apiVersion: "rbac.authorization.k8s.io/v1",
    kind: "RoleBinding",
    metadata: { name: "marco-developer", namespace: "team-checkout" },
    subjects: [
      { kind: "ServiceAccount", name: "marco", namespace: "team-checkout" },
      { kind: "User", name: "priya@example.com" },
    ],
    roleRef: {
      apiGroup: "rbac.authorization.k8s.io",
      kind: "ClusterRole",
      name: "view",
    },
  };

  /** A ServiceAccount subject opens its object; a User is only a name. */
  it("links a ServiceAccount subject to its own page", () => {
    const [account, user] = group(binding, "subjects")!.items;
    expect(account.label).toBe("ServiceAccount");
    expect(props(account.value)).toMatchObject({
      kind: "ServiceAccount",
      name: "marco",
      namespace: "team-checkout",
      crd: "serviceaccounts",
      showNamespace: false,
    });
    expect(user).toMatchObject({
      label: "User",
      value: "priya@example.com",
    });
  });

  it("links the role it grants, cluster-wide for a ClusterRole", () => {
    const [granted] = group(binding, "roleRef")!.items;
    expect(granted.label).toBe("ClusterRole");
    expect(props(granted.value)).toMatchObject({
      kind: "ClusterRole",
      name: "view",
      namespace: null,
      crd: "clusterroles.rbac.authorization.k8s.io",
    });
  });

  it("shows the namespace of a subject from another one", () => {
    const across = {
      ...binding,
      subjects: [{ kind: "ServiceAccount", name: "ci", namespace: "tools" }],
    };
    const [account] = group(across, "subjects")!.items;
    expect(props(account.value)).toMatchObject({
      namespace: "tools",
      showNamespace: true,
    });
  });
});
