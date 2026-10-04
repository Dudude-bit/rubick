import { fireEvent, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type {
  Cascade,
  Dependent,
  Dependents,
  Lineage,
  NotRead,
} from "@/generated/types";
import { SurfaceVisibility } from "@/lib/surface-visibility";
import { useClusterStore } from "@/stores/clusterStore";
import { renderWithRouter } from "@/test/render";

const answers = vi.hoisted(() => ({
  lineage: null as unknown as () => Promise<Lineage>,
  dependents: null as unknown as (uid: string) => Promise<Dependents>,
  cascade: null as unknown as () => Promise<Cascade>,
  asked: [] as string[],
}));

vi.mock("@/lib/commands", () => ({
  commands: {
    objectLineage: () => answers.lineage(),
    listDependents: (uid: string) => {
      answers.asked.push(uid);
      return answers.dependents(uid);
    },
    previewCascade: () => answers.cascade(),
  },
}));

const { LineageTrail } = await import("./Lineage");
const { OwnsPanel } = await import("./Owns");
const { CascadePreview } = await import("./CascadePreview");

const NOTHING_UNREAD: NotRead = { kinds: [], groups: [] };

const dependent = (kind: string, name: string, dependents = 0): Dependent => ({
  uid: `uid-${name}`,
  kind,
  group: kind === "ReplicaSet" ? "apps" : "",
  version: "v1",
  plural: kind === "ReplicaSet" ? "replicasets" : "pods",
  name,
  namespace: "shop",
  controlled: true,
  dependents,
});

beforeEach(() => {
  answers.asked = [];
  useClusterStore.setState({ currentContext: "test", isConnected: true });
});

describe("the owners above an object", () => {
  it("reads top first, each owner a link to its page", async () => {
    answers.lineage = () =>
      Promise.resolve({
        uid: "p",
        ancestors: [
          {
            uid: "r",
            kind: "ReplicaSet",
            group: "apps",
            plural: "replicasets",
            name: "api-7f9",
            namespace: "shop",
          },
          {
            uid: "d",
            kind: "Deployment",
            group: "apps",
            plural: "deployments",
            name: "api",
            namespace: "shop",
          },
        ],
        others: [],
        stop: null,
      });
    await renderWithRouter(
      <LineageTrail
        served={{ group: "", plural: "pods" }}
        name="api-7f9-x"
        namespace="shop"
      />
    );
    const links = await screen.findAllByRole("link");
    expect(links.map((link) => link.textContent)).toEqual(["api", "api-7f9"]);
    expect(links[0]).toHaveAttribute("href", "/c/test/deployments/shop/api");
  });

  /** An owner nobody could read must not read as an owner that is gone. */
  it("says where the chain stopped and why", async () => {
    answers.lineage = () =>
      Promise.resolve({
        uid: "p",
        ancestors: [],
        others: [],
        stop: {
          says: "ownerUnread",
          kind: "ReplicaSet",
          name: "api-7f9",
          code: "PERMISSION_DENIED",
          message: "replicasets is forbidden",
        },
      });
    await renderWithRouter(
      <LineageTrail
        served={{ group: "", plural: "pods" }}
        name="api-7f9-x"
        namespace="shop"
      />
    );
    expect(
      await screen.findByText("ReplicaSet api-7f9 (not read)")
    ).toBeInTheDocument();
    expect(screen.queryByText(/gone/)).toBeNull();
  });
});

describe("what an object owns", () => {
  it("lists its dependents and opens one a level down", async () => {
    answers.dependents = (uid) =>
      Promise.resolve({
        dependents:
          uid === "d"
            ? [dependent("ReplicaSet", "api-7f9", 2)]
            : [dependent("Pod", "api-7f9-a"), dependent("Pod", "api-7f9-b")],
        notRead: NOTHING_UNREAD,
      });
    await renderWithRouter(<OwnsPanel uid="d" />);
    expect(await screen.findByText("owns 2")).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", { name: "Show what api-7f9 owns" })
    );
    expect(await screen.findByText("api-7f9-b")).toBeInTheDocument();
    expect(answers.asked).toContain("uid-api-7f9");
  });

  /**
   * "Owns nothing" is only ever said about the kinds read; a kind still
   * listing is named beside it, never folded into the nothing.
   */
  it("names the kinds it has not read beside an empty answer", async () => {
    answers.dependents = () =>
      Promise.resolve({
        dependents: [],
        notRead: {
          kinds: [
            {
              kind: "Pod",
              group: "",
              plural: "pods",
              reading: { says: "syncing" },
            },
          ],
          groups: [],
        },
      });
    await renderWithRouter(<OwnsPanel uid="d" />);
    expect(
      await screen.findByText("Owns nothing among the kinds read.")
    ).toBeInTheDocument();
    expect(screen.getByText("1 kind not read")).toBeInTheDocument();
    expect(screen.getByText("Pod (still listing)")).toBeInTheDocument();
  });

  /** Asking starts a cluster-wide index; a tab nobody opened must not. */
  it("asks nothing while its tab is off screen", async () => {
    answers.dependents = () =>
      Promise.resolve({ dependents: [], notRead: NOTHING_UNREAD });
    await renderWithRouter(
      <SurfaceVisibility.Provider value={false}>
        <OwnsPanel uid="d" />
      </SurfaceVisibility.Provider>
    );
    expect(answers.asked).toEqual([]);
  });
});

describe("what deleting an object takes with it", () => {
  beforeEach(() => {
    answers.lineage = () =>
      Promise.resolve({ uid: "d", ancestors: [], others: [], stop: null });
  });

  it("counts what goes with it, and names kinds it could not read", async () => {
    answers.cascade = () =>
      Promise.resolve({
        takes: [
          { kind: "Pod", group: "", plural: "pods", count: 12 },
          {
            kind: "ReplicaSet",
            group: "apps",
            plural: "replicasets",
            count: 3,
          },
        ],
        notRead: {
          kinds: [
            {
              kind: "Secret",
              group: "",
              plural: "secrets",
              reading: { says: "refused", message: "forbidden" },
            },
          ],
          groups: [],
        },
      });
    await renderWithRouter(
      <CascadePreview kind="Deployment" name="api" namespace="shop" />
    );
    expect(await screen.findByText("Pod ×12")).toBeInTheDocument();
    expect(
      screen.getByText(
        "And possibly objects of kinds not read: Secret (refused)."
      )
    ).toBeInTheDocument();
  });

  /** Before a delete, a count it could not work out is said, never skipped. */
  it("says it could not work out the cascade rather than saying nothing", async () => {
    answers.cascade = () =>
      Promise.reject({ code: "PERMISSION_DENIED", message: "forbidden" });
    await renderWithRouter(
      <CascadePreview kind="Deployment" name="api" namespace="shop" />
    );
    expect(
      await screen.findByText(/Could not work out what goes with it/)
    ).toBeInTheDocument();
  });
});
