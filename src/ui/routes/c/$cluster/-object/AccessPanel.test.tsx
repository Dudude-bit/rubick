import { screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type { BindingInfo, Scoped } from "@/generated/types";
import { useClusterStore } from "@/stores/clusterStore";
import { renderWithRouter } from "@/test/render";

const answers = vi.hoisted(() => ({
  roleBindings: (scope: string[] | null): Promise<Scoped<BindingInfo>> => {
    void scope;
    return Promise.resolve({ rows: [], unread: [] });
  },
  clusterRoleBindings: (): Promise<BindingInfo[]> => Promise.resolve([]),
  object: (plural: string, name: string): Promise<unknown> => {
    void plural;
    void name;
    return Promise.reject({ code: "NOT_FOUND", message: "not found" });
  },
}));

vi.mock("@/lib/commands", () => ({
  commands: {
    listRoleBindingsIn: (scope: string[] | null) => answers.roleBindings(scope),
    listClusterRoleBindings: () => answers.clusterRoleBindings(),
    getServedObject: (_group: string, plural: string, name: string) =>
      answers.object(plural, name),
  },
}));

const { AccessPanel } = await import("./AccessPanel");

const refused = (what: string) => ({
  code: "PERMISSION_DENIED",
  message: `${what} is forbidden: User "system:serviceaccount:team-checkout:marco" cannot list resource "${what}"`,
});

const binding = (
  kind: "RoleBinding" | "ClusterRoleBinding",
  name: string,
  role: { kind: string; name: string },
  subjects: BindingInfo["subjects"]
): BindingInfo => ({
  kind,
  name,
  namespace: kind === "RoleBinding" ? "team-checkout" : null,
  roleRef: role,
  subjects,
});

const MARCO = {
  kind: "ServiceAccount",
  name: "marco",
  namespace: "team-checkout",
};

const marcoDeveloper = binding(
  "RoleBinding",
  "marco-developer",
  { kind: "Role", name: "developer" },
  [{ kind: "ServiceAccount", name: "marco", namespace: "team-checkout" }]
);

const developer = {
  apiVersion: "rbac.authorization.k8s.io/v1",
  kind: "Role",
  metadata: { name: "developer", namespace: "team-checkout" },
  rules: [
    { apiGroups: [""], resources: ["pods/exec"], verbs: ["create", "get"] },
  ],
};

const read = (rows: BindingInfo[]) => () =>
  Promise.resolve({ rows, unread: [] });

const open = (target: {
  kind: string;
  name: string;
  namespace: string | null;
}) =>
  renderWithRouter(
    <AccessPanel
      kind={target.kind}
      name={target.name}
      namespace={target.namespace}
      heading={(title, count) => (
        <h3>
          {title} {count}
        </h3>
      )}
    />
  );

beforeEach(() => {
  useClusterStore.setState({
    currentContext: "test",
    isConnected: true,
    namespaceScope: [],
  });
  answers.roleBindings = read([]);
  answers.clusterRoleBindings = () => Promise.resolve([]);
  answers.object = () =>
    Promise.reject({ code: "NOT_FOUND", message: "not found" });
});

const NO_GRANTS =
  "No ClusterRoleBinding, and no RoleBinding in team-checkout, grants it anything.";

describe("what a ServiceAccount may do", () => {
  /** Priya's question, answered: marco's binding, its role, and the role's rules. */
  it("draws each binding that names it with the rules of the role it grants", async () => {
    answers.roleBindings = read([marcoDeveloper]);
    answers.object = (plural, name) =>
      plural === "roles" && name === "developer"
        ? Promise.resolve(developer)
        : Promise.reject({ code: "NOT_FOUND", message: "not found" });
    await open(MARCO);
    expect(await screen.findByText("pods/exec")).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "RoleBinding marco-developer" })
    ).toHaveAttribute(
      "href",
      "/c/test/rolebindings.rbac.authorization.k8s.io/team-checkout/marco-developer"
    );
    expect(
      screen.getByRole("link", { name: "Role developer" })
    ).toHaveAttribute(
      "href",
      "/c/test/roles.rbac.authorization.k8s.io/team-checkout/developer"
    );
    expect(screen.getByRole("heading")).toHaveTextContent("What it may do 1");
    expect(screen.queryByText(NO_GRANTS)).toBeNull();
  });

  /**
   * The thesis case: a refused RoleBinding list is not an empty one. Fails
   * if the panel says "grants it anything" over a list it could not read.
   */
  it("never says it is granted nothing when a binding list was refused", async () => {
    answers.roleBindings = () => Promise.reject(refused("rolebindings"));
    await open(MARCO);
    expect(
      await screen.findByText(
        "None found, but not every binding could be read."
      )
    ).toBeInTheDocument();
    expect(
      screen.getByText("Could not read RoleBindings in team-checkout.")
    ).toBeInTheDocument();
    expect(screen.getByText(/The cluster refused: rolebindings/)).toBeVisible();
    expect(screen.queryByText(NO_GRANTS)).toBeNull();
  });

  /** And the same for the cluster-wide list, beside a grant it did find. */
  it("keeps what it found and names the ClusterRoleBindings it could not read", async () => {
    answers.roleBindings = read([marcoDeveloper]);
    answers.clusterRoleBindings = () =>
      Promise.reject(refused("clusterrolebindings"));
    await open(MARCO);
    expect(
      await screen.findByText(
        "Not every binding could be read, so there may be more than this."
      )
    ).toBeInTheDocument();
    expect(
      screen.getByText("Could not read ClusterRoleBindings across the cluster.")
    ).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "RoleBinding marco-developer" })
    ).toBeInTheDocument();
    // One found over an unread list is not a total of one.
    expect(screen.getByRole("heading").textContent?.trim()).toBe(
      "What it may do"
    );
  });

  /** Only every list read and none matching is a no. */
  it("says it is granted nothing only when every list was read", async () => {
    answers.roleBindings = read([
      binding("RoleBinding", "someone-else", { kind: "Role", name: "x" }, [
        { kind: "ServiceAccount", name: "ci", namespace: "team-checkout" },
      ]),
    ]);
    await open(MARCO);
    expect(await screen.findByText(NO_GRANTS)).toBeInTheDocument();
    expect(
      screen.getByText(/RoleBindings in other namespaces were not read/)
    ).toBeVisible();
  });

  /** A binding to a role that is gone grants nothing; it is not "rules unknown". */
  it("says a binding whose role does not exist grants nothing", async () => {
    answers.roleBindings = read([marcoDeveloper]);
    await open(MARCO);
    expect(
      await screen.findByText(
        "Role developer does not exist, so this binding grants nothing."
      )
    ).toBeInTheDocument();
  });

  /** A role the reader may not read is unknown, not empty and not missing. */
  it("names a role it could not read, with the cluster's reason", async () => {
    answers.roleBindings = read([marcoDeveloper]);
    answers.object = () => Promise.reject(refused("roles"));
    await open(MARCO);
    expect(
      await screen.findByText(
        "Could not read Role developer, so what this binding grants is not known."
      )
    ).toBeInTheDocument();
    expect(
      screen.getByText(/The cluster refused: roles is forbidden/)
    ).toBeVisible();
    expect(screen.queryByText(/does not exist/)).toBeNull();
    expect(screen.queryByText("Grants nothing: no rules.")).toBeNull();
  });

  /**
   * A group every account in the namespace is in grants as much as naming
   * it does; the grants every account or every user gets are folded below.
   */
  it("follows the groups a ServiceAccount is in, and folds the broad ones", async () => {
    answers.roleBindings = read([
      binding(
        "RoleBinding",
        "team-view",
        { kind: "ClusterRole", name: "view" },
        [
          {
            kind: "Group",
            name: "system:serviceaccounts:team-checkout",
            namespace: null,
          },
        ]
      ),
    ]);
    answers.clusterRoleBindings = () =>
      Promise.resolve([
        binding(
          "ClusterRoleBinding",
          "system:discovery",
          { kind: "ClusterRole", name: "system:discovery" },
          [{ kind: "Group", name: "system:authenticated", namespace: null }]
        ),
      ]);
    await open(MARCO);
    expect(
      await screen.findByText("through system:serviceaccounts:team-checkout")
    ).toBeVisible();
    const folded = screen.getByText(
      "1 more binding grants this to every ServiceAccount or to everyone signed in"
    );
    expect(folded.closest("details")).not.toHaveAttribute("open");
    expect(screen.getByRole("heading")).toHaveTextContent("What it may do 2");
  });
});

describe("whom a role is bound to", () => {
  /** The reverse lookup: Role developer, to RoleBinding marco-developer, to marco. */
  it("lists the bindings that grant a Role with their subjects linked", async () => {
    answers.roleBindings = read([
      marcoDeveloper,
      binding("RoleBinding", "other", { kind: "Role", name: "viewer" }, []),
    ]);
    await open({ kind: "Role", name: "developer", namespace: "team-checkout" });
    const row = (
      await screen.findByRole("link", { name: "RoleBinding marco-developer" })
    ).parentElement!.parentElement!;
    expect(
      within(row).getByRole("link", { name: "ServiceAccount marco" })
    ).toHaveAttribute("href", "/c/test/serviceaccounts/team-checkout/marco");
    expect(
      screen.queryByRole("link", { name: "RoleBinding other" })
    ).toBeNull();
  });

  /** "Nobody" over a refused list would be the same lie as "nothing". */
  it("never says a Role is bound to nobody when the list was refused", async () => {
    answers.roleBindings = () => Promise.reject(refused("rolebindings"));
    await open({ kind: "Role", name: "developer", namespace: "team-checkout" });
    expect(
      await screen.findByText(
        "None found, but not every binding could be read."
      )
    ).toBeInTheDocument();
    expect(
      screen.queryByText("No RoleBinding in team-checkout grants it.")
    ).toBeNull();
  });

  /**
   * A ClusterRole is granted from anywhere. Under picked namespaces only
   * those are read, and the panel says the rest were not looked at.
   */
  it("reads a ClusterRole's RoleBindings where the window looks, and says so", async () => {
    useClusterStore.setState({ namespaceScope: ["team-checkout"] });
    const asked: Array<string[] | null> = [];
    answers.roleBindings = (scope) => {
      asked.push(scope);
      return Promise.resolve({ rows: [], unread: [] });
    };
    answers.clusterRoleBindings = () =>
      Promise.resolve([
        binding(
          "ClusterRoleBinding",
          "admins",
          { kind: "ClusterRole", name: "view" },
          [{ kind: "Group", name: "platform", namespace: null }]
        ),
      ]);
    await open({ kind: "ClusterRole", name: "view", namespace: null });
    expect(
      await screen.findByRole("link", { name: "ClusterRoleBinding admins" })
    ).toBeInTheDocument();
    expect(screen.getByText("platform")).toBeInTheDocument();
    expect(asked).toContainEqual(["team-checkout"]);
    expect(
      screen.getByText(
        "RoleBindings were read only in team-checkout. The other namespaces were not looked at."
      )
    ).toBeInTheDocument();
  });

  /** One namespace refused among several is named, and the verdict waits on it. */
  it("names a namespace whose RoleBindings could not be read", async () => {
    useClusterStore.setState({ namespaceScope: ["team-checkout", "payments"] });
    answers.roleBindings = () =>
      Promise.resolve({
        rows: [],
        unread: [
          {
            namespace: "payments",
            code: "PERMISSION_DENIED",
            message: "rolebindings is forbidden",
          },
        ],
      });
    await open({ kind: "ClusterRole", name: "view", namespace: null });
    expect(
      await screen.findByText("Could not read RoleBindings in payments.")
    ).toBeInTheDocument();
    expect(
      screen.queryByText(/No ClusterRoleBinding, and no RoleBinding in/)
    ).toBeNull();
  });
});
