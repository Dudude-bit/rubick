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

const NOTHING_UNREAD: NotRead = { kinds: [], groups: [], watched: 40 };

const SECRETS_REFUSED = {
  kind: "Secret",
  group: "",
  plural: "secrets",
  reading: { says: "refused" as const, message: "forbidden" },
};

const chipOf = (kind: string) => screen.getByText(kind).closest("li");

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
    expect(links.map((link) => link.textContent)).toEqual([
      "Deployment/api",
      "ReplicaSet/api-7f9",
    ]);
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
   * Linked by kind name alone, an Istio Gateway a controller made opened the
   * Gateway API page of a Gateway that does not exist.
   */
  it("opens a dependent by its group, the Gateway API page only for a Gateway API Gateway", async () => {
    const gateway = (group: string, name: string): Dependent => ({
      ...dependent("Gateway", name),
      group,
      plural: "gateways",
    });
    answers.dependents = () =>
      Promise.resolve({
        dependents: [
          gateway("networking.istio.io", "mesh"),
          gateway("gateway.networking.k8s.io", "edge"),
        ],
        notRead: NOTHING_UNREAD,
      });
    await renderWithRouter(<OwnsPanel uid="d" />);
    expect(
      await screen.findByRole("link", { name: "Gateway mesh" })
    ).toHaveAttribute("href", "/c/test/gateways.networking.istio.io/shop/mesh");
    expect(screen.getByRole("link", { name: "Gateway edge" })).toHaveAttribute(
      "href",
      "/c/test/gateways/shop/edge"
    );
  });

  /**
   * While a kind is still listing, "owns nothing" would be premature: the
   * panel says it is still reading and names the kind, never folds it in.
   */
  it("says it is still reading rather than that it owns nothing", async () => {
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
          watched: 40,
        },
      });
    await renderWithRouter(<OwnsPanel uid="d" />);
    expect(
      await screen.findByText("Reading the kinds that can be watched: 39 of 40")
    ).toBeInTheDocument();
    expect(screen.queryByText("Owns nothing among the kinds read.")).toBeNull();
    expect(chipOf("Pod")).toHaveTextContent("still listing");
  });

  /** "Owns nothing" is only ever said about the kinds read, beside the rest. */
  it("names the kinds it could not read beside an empty answer", async () => {
    answers.dependents = () =>
      Promise.resolve({
        dependents: [],
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
          watched: 40,
        },
      });
    await renderWithRouter(<OwnsPanel uid="d" />);
    expect(
      await screen.findByText("Owns nothing among the kinds read.")
    ).toBeInTheDocument();
    expect(chipOf("Secret")).toHaveTextContent("refused");
  });

  /**
   * The Owns tab reads the same index as Delete, where Marco saw kinds read in
   * the pod's own namespace counted as unread. Fails if the ConfigMap read
   * there is still counted, or if the refused Secret is not.
   */
  it("does not count a kind read in the owner's namespace among those not read", async () => {
    answers.dependents = () =>
      Promise.resolve({
        dependents: [],
        notRead: {
          kinds: [
            {
              kind: "ConfigMap",
              group: "",
              plural: "configmaps",
              reading: { says: "partial", namespaces: ["team-checkout"] },
            },
            SECRETS_REFUSED,
          ],
          groups: [],
          watched: 72,
        },
      });
    await renderWithRouter(<OwnsPanel uid="d" namespace="team-checkout" />);
    expect(
      await screen.findByText("1 kind not read in full")
    ).toBeInTheDocument();
    expect(chipOf("Secret")).toHaveTextContent("refused");
    expect(screen.queryByText("ConfigMap")).toBeNull();
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
          watched: 40,
        },
        holds: null,
      });
    await renderWithRouter(
      <CascadePreview kind="Deployment" name="api" namespace="shop" />
    );
    expect(await screen.findByText("Also deletes:")).toBeInTheDocument();
    expect(chipOf("Pod")).toHaveTextContent("12");
    expect(chipOf("ReplicaSet")).toHaveTextContent("3");
    expect(
      screen.getByText("And possibly objects of the kinds it could not read:")
    ).toBeInTheDocument();
    expect(chipOf("Secret")).toHaveTextContent("refused");
  });

  /** "Nothing" is green only when nothing could be hiding; a hedge is not safe. */
  it("does not paint nothing green while a kind is unread", async () => {
    const nothing = (notRead: NotRead) => {
      answers.cascade = () =>
        Promise.resolve({ takes: [], notRead, holds: null });
      return renderWithRouter(
        <CascadePreview kind="ConfigMap" name="settings" namespace="shop" />
      );
    };
    const view = await nothing(NOTHING_UNREAD);
    const line = await screen.findByText(
      "Nothing else goes with it, among the kinds read."
    );
    expect(line).toHaveClass("text-ok");
    view.unmount();
    await nothing({ kinds: [SECRETS_REFUSED], groups: [], watched: 40 });
    expect(
      await screen.findByText(
        "Nothing else goes with it, among the kinds read."
      )
    ).not.toHaveClass("text-ok");
  });

  const syncing = (n: number) =>
    Array.from({ length: n }, (_, index) => ({
      kind: `Kind${index}`,
      group: `g${index}.example.com`,
      plural: `kinds${index}`,
      reading: { says: "syncing" as const },
    }));

  /**
   * Dana and Lena opened Delete onto fifty "still listing" chips and the
   * confirm field off screen. While the index lists, one line says how far
   * it got, folded over the chips, and no answer is given yet.
   */
  it("says how far the index got in one folded line while it lists", async () => {
    answers.cascade = () =>
      Promise.resolve({
        takes: [{ kind: "Pod", group: "", plural: "pods", count: 2 }],
        notRead: {
          kinds: [...syncing(48), SECRETS_REFUSED],
          groups: [],
          watched: 50,
        },
        holds: null,
      });
    await renderWithRouter(
      <CascadePreview kind="Deployment" name="api" namespace="shop" />
    );
    const line = await screen.findByText(
      "Reading the kinds that can be watched: 2 of 50"
    );
    expect(line.closest("details")).not.toHaveAttribute("open");
    expect(screen.queryByText("Also deletes:")).toBeNull();
    expect(screen.queryByText(/Nothing else goes with it/)).toBeNull();
  });

  /**
   * Marco's Delete said "Reading kinds: 0 of 72 read" beside API resources'
   * 82, and nothing said why ten were missing. Fails unless the line says
   * the total is the kinds that can be watched, and names the kinds served
   * and what is left out.
   */
  it("says what its total counts and how it stands to the kinds served", async () => {
    const unwatched = (kind: string, says: "unlistable" | "skipped") => ({
      kind,
      group: "",
      plural: `${kind.toLowerCase()}s`,
      reading: { says },
    });
    answers.cascade = () =>
      Promise.resolve({
        takes: [],
        notRead: {
          kinds: [
            ...syncing(72),
            ...["Binding", "TokenReview", "ComponentStatus"].map((kind) =>
              unwatched(kind, "unlistable")
            ),
            unwatched("Event", "skipped"),
          ],
          groups: [],
          watched: 72,
        },
        holds: null,
      });
    await renderWithRouter(
      <CascadePreview kind="Pod" name="api-1" namespace="shop" />
    );
    expect(
      await screen.findByText("Reading the kinds that can be watched: 0 of 72")
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "76 kinds served; Events and kinds that cannot be watched are left out"
      )
    ).toBeInTheDocument();
  });

  /** Once listed, what failed stays named: reading ending is not reading all. */
  it("still names the kinds it could not read once listing ends", async () => {
    answers.cascade = () =>
      Promise.resolve({
        takes: [],
        notRead: { kinds: [SECRETS_REFUSED], groups: [], watched: 50 },
        holds: null,
      });
    await renderWithRouter(
      <CascadePreview kind="Deployment" name="api" namespace="shop" />
    );
    expect(
      await screen.findByText(
        "And possibly objects of the kinds it could not read:"
      )
    ).toBeInTheDocument();
    expect(chipOf("Secret")).toHaveTextContent("refused");
    expect(screen.queryByText(/Reading the kinds/)).toBeNull();
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

describe("what deleting a CRD or a namespace takes with it", () => {
  beforeEach(() => {
    answers.lineage = () =>
      Promise.resolve({ uid: "x", ancestors: [], others: [], stop: null });
  });

  const widgets = (
    count: number,
    reading: Extract<Cascade["holds"], { says: "objects" }>["reading"]
  ): Cascade => ({
    takes: count
      ? [{ kind: "Widget", group: "demo.k8s-gui.io", plural: "widgets", count }]
      : [],
    notRead: NOTHING_UNREAD,
    holds: {
      says: "objects",
      kind: "Widget",
      group: "demo.k8s-gui.io",
      plural: "widgets",
      count,
      reading,
    },
  });

  const crd = () =>
    renderWithRouter(
      <CascadePreview
        kind="CustomResourceDefinition"
        name="widgets.demo.k8s-gui.io"
      />
    );

  /**
   * The reported case: no ownerReference names a CRD, so the dialog said in
   * green that nothing else goes, about a CRD with live objects.
   */
  it("counts every object of a CRD's kind as going, in the danger tone", async () => {
    answers.cascade = () => Promise.resolve(widgets(62, null));
    await crd();
    const said = await screen.findByText(
      "Every Widget in the cluster goes with it:"
    );
    expect(said.closest("p")).toHaveClass("text-err");
    expect(screen.getByText("62")).toHaveClass("text-err");
    expect(screen.queryByText(/Nothing else goes with it/)).toBeNull();
    expect(
      screen.getByRole("link", { name: /Open their list/ })
    ).toHaveAttribute(
      "href",
      "/c/test/customresourcedefinitions/widgets.demo.k8s-gui.io?tab=instances"
    );
  });

  /** A refused list is not "none": the kind is named with why, and they still go. */
  it("names a refused kind as unread rather than counting it as none", async () => {
    answers.cascade = () =>
      Promise.resolve(
        widgets(0, { says: "refused", message: "widgets is forbidden" })
      );
    await crd();
    expect(
      await screen.findByText("Every Widget in the cluster goes with it:")
    ).toBeInTheDocument();
    expect(chipOf("Widget")).toHaveTextContent("refused");
    expect(screen.queryByText(/No Widget exists/)).toBeNull();
  });

  /** A kind still listing has counted nothing yet; zero is not the answer. */
  it("names a kind still listing instead of saying none exists", async () => {
    answers.cascade = () => Promise.resolve(widgets(0, { says: "syncing" }));
    await crd();
    expect(await screen.findByText("still listing")).toBeInTheDocument();
    expect(screen.queryByText(/No Widget exists/)).toBeNull();
  });

  it("says none goes only when the kind was read and has none", async () => {
    answers.cascade = () => Promise.resolve(widgets(0, null));
    await crd();
    expect(
      await screen.findByText("No Widget exists, so none goes with it.")
    ).toHaveClass("text-ok");
  });

  /** The index had not read the CRD itself: what it holds is unknown, not nothing. */
  it("says what a CRD holds is unread when the index could not place it", async () => {
    answers.cascade = () =>
      Promise.resolve({
        takes: [],
        notRead: {
          kinds: [
            {
              kind: "CustomResourceDefinition",
              group: "apiextensions.k8s.io",
              plural: "customresourcedefinitions",
              reading: { says: "refused", message: "forbidden" },
            },
          ],
          groups: [],
          watched: 40,
        },
        holds: null,
      });
    await crd();
    expect(
      await screen.findByText(/what it holds could not be read/)
    ).toBeInTheDocument();
    expect(screen.queryByText(/Nothing else goes with it/)).toBeNull();
  });

  /** A namespace takes everything inside it, counted per kind, unread kinds named. */
  it("counts everything inside a namespace and names what it could not read", async () => {
    answers.cascade = () =>
      Promise.resolve({
        takes: [
          { kind: "Pod", group: "", plural: "pods", count: 3 },
          { kind: "ConfigMap", group: "", plural: "configmaps", count: 2 },
        ],
        notRead: { kinds: [SECRETS_REFUSED], groups: [], watched: 40 },
        holds: { says: "namespace" },
      });
    await renderWithRouter(<CascadePreview kind="Namespace" name="shop" />);
    expect(
      await screen.findByText("Everything inside goes with it:")
    ).toBeInTheDocument();
    expect(chipOf("Pod")).toHaveTextContent("3");
    expect(chipOf("ConfigMap")).toHaveTextContent("2");
    expect(chipOf("Secret")).toHaveTextContent("refused");
  });
});
