import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type {
  Cascade,
  Dependent,
  Dependents,
  Lineage,
  NotRead,
} from "@/generated/types";
import { queryKeys } from "@/lib/query-keys";
import { SurfaceVisibility } from "@/lib/surface-visibility";
import { useClusterStore } from "@/stores/clusterStore";
import { renderWithRouter, testQueryClient } from "@/test/render";

const answers = vi.hoisted(() => ({
  lineage: null as unknown as () => Promise<Lineage>,
  dependents: null as unknown as (
    uid: string,
    page: number
  ) => Promise<
    Pick<Dependents, "dependents" | "notRead"> & Partial<Dependents>
  >,
  cascade: null as unknown as (uid: string) => Promise<Cascade>,
  asked: [] as string[],
}));

vi.mock("@/lib/commands", () => ({
  commands: {
    objectLineage: () => answers.lineage(),
    listDependents: async (uid: string, _scope: unknown, page: number) => {
      answers.asked.push(uid);
      const answer = await answers.dependents(uid, page);
      return {
        page: 0,
        pageSize: 100,
        total: answer.dependents.length,
        ...answer,
      };
    },
    previewCascade: (uid: string) => answers.cascade(uid),
  },
}));

const { useLineage } = await import("./ownership");
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

  /**
   * Lena, cluster-admin: "10 kinds not read in full" under every Deployment,
   * ReplicaSet and Pod. They were the two Events kinds, left out on purpose,
   * and the eight review and binding kinds discovery offers no list of; none
   * can hold a dependent. Fails if they are counted as a gap again, or if
   * they stop being named with why.
   */
  it("names the kinds left out apart from those that could hide a dependent", async () => {
    const unwatched = (
      kind: string,
      says: "unlistable" | "unwatchable" | "skipped"
    ) => ({
      kind,
      group: kind === "Event" ? "" : "authorization.k8s.io",
      plural: `${kind.toLowerCase()}s`,
      reading: { says },
    });
    answers.dependents = () =>
      Promise.resolve({
        dependents: [dependent("ReplicaSet", "cart-9df89489c", 2)],
        notRead: {
          kinds: [
            unwatched("Event", "skipped"),
            unwatched("ComponentStatus", "unwatchable"),
            ...["Binding", "TokenReview"].map((kind) =>
              unwatched(kind, "unlistable")
            ),
          ],
          groups: [],
          watched: 104,
        },
      });
    await renderWithRouter(<OwnsPanel uid="d" namespace="shop" />);

    expect(
      await screen.findByText("Read 104 of 104 kinds that can be watched")
    ).toBeInTheDocument();
    expect(screen.queryByText(/not read in full/)).toBeNull();
    expect(screen.getByTestId("left-out")).toHaveTextContent(
      "108 kinds served; Events and kinds that cannot be watched are left out"
    );
    expect(chipOf("Event")).toHaveTextContent("left out");
    expect(chipOf("Binding")).toHaveTextContent("cannot be listed");
  });

  /**
   * Dana: ComponentStatus wore "cannot be listed" on every Owns tab while
   * kubectl get cs listed it; its verbs are get and list, and only a watch is
   * missing. Fails if a kind is left out under a verb it has.
   */
  it("says a kind with a list and no watch cannot be watched", async () => {
    answers.dependents = () =>
      Promise.resolve({
        dependents: [],
        notRead: {
          kinds: [
            {
              kind: "ComponentStatus",
              group: "",
              plural: "componentstatuses",
              reading: { says: "unwatchable" },
            },
          ],
          groups: [],
          watched: 60,
        },
      });
    await renderWithRouter(<OwnsPanel uid="d" namespace="shop" />);

    expect(
      await screen.findByText("Read 60 of 60 kinds that can be watched")
    ).toBeInTheDocument();
    expect(screen.queryByText(/not read in full/)).toBeNull();
    expect(chipOf("ComponentStatus")).toHaveTextContent("cannot be watched");
    expect(chipOf("ComponentStatus")).not.toHaveTextContent("cannot be listed");
  });

  /**
   * A kind past the app's ceiling on watches was never asked, which is not
   * "read, and nothing there". Fails if it is left out of the kinds that
   * could hide a dependent, or is not named with why.
   */
  it("counts a kind still waiting for a watch among those not read", async () => {
    answers.dependents = () =>
      Promise.resolve({
        dependents: [],
        notRead: {
          kinds: [
            {
              kind: "Widget",
              group: "demo.example.com",
              plural: "widgets",
              reading: { says: "queued" },
            },
          ],
          groups: [],
          watched: 301,
        },
      });
    await renderWithRouter(<OwnsPanel uid="d" namespace="shop" />);
    expect(
      await screen.findByText("1 kind not read in full")
    ).toBeInTheDocument();
    expect(chipOf("Widget")).toHaveTextContent("waiting its turn");
  });

  /**
   * An Argo Workflow's 5000 step pods came in one answer and were all drawn
   * as rows. Fails if more than the page answered is drawn, if the rest are
   * not counted, or if the next page cannot be reached.
   */
  it("draws an owner of thousands a page at a time and says which rows these are", async () => {
    const pages: number[] = [];
    answers.dependents = (_uid, page) => {
      pages.push(page);
      return Promise.resolve({
        dependents: Array.from({ length: page === 2 ? 50 : 100 }, (_, n) =>
          dependent("Pod", `step-${page * 100 + n}`)
        ),
        page,
        total: 250,
        notRead: NOTHING_UNREAD,
      });
    };
    await renderWithRouter(<OwnsPanel uid="w" namespace="shop" />);
    expect(await screen.findByText("1–100 of 250")).toBeInTheDocument();
    expect(screen.getAllByRole("treeitem")).toHaveLength(100);
    expect(
      screen.getByRole("button", { name: "Previous page" })
    ).toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: "Next page" }));
    expect(await screen.findByText("101–200 of 250")).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "Pod step-100" })
    ).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Pod step-0" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Next page" }));
    expect(await screen.findByText("201–250 of 250")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Next page" })).toBeDisabled();
    expect(pages).toContain(2);
  });

  /** One page that holds everything has nowhere else to go. */
  it("offers no pages where one holds every dependent", async () => {
    answers.dependents = () =>
      Promise.resolve({
        dependents: [dependent("Pod", "api-7f9-a")],
        notRead: NOTHING_UNREAD,
      });
    await renderWithRouter(<OwnsPanel uid="d" />);
    expect(
      await screen.findByRole("link", { name: "Pod api-7f9-a" })
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Next page" })).toBeNull();
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

describe("an object made again under the same name", () => {
  const lineageOf = (uid: string): Lineage => ({
    uid,
    ancestors: [],
    others: [],
    stop: null,
  });

  /**
   * Argo replaced Deployment `api` while its page was open: the page read the
   * new object while Owns, Alt and the arrows and Delete went on asking about
   * the old uid, whose ReplicaSet the garbage collector had taken, so "owns
   * nothing" stood over an object that owns pods. Fails if the lineage is not
   * asked again once the page holds another uid, or if the old uid is given
   * out while it is.
   */
  it("is known by the uid its page now reads, never the one before", async () => {
    function Uid() {
      const lineage = useLineage(
        { group: "apps", plural: "deployments" },
        "api",
        "shop"
      );
      return <output>{lineage.data?.uid ?? "not known"}</output>;
    }
    const client = testQueryClient();
    const page = queryKeys.detail("Deployment", "shop", "api");
    client.setQueryData(page, { uid: "old" });
    answers.lineage = () => Promise.resolve(lineageOf("old"));
    await renderWithRouter(<Uid />, { client });
    expect(await screen.findByText("old")).toBeInTheDocument();

    let answer = (_: Lineage) => {};
    answers.lineage = () => new Promise((resolve) => (answer = resolve));
    act(() => client.setQueryData(page, { uid: "new" }));
    expect(await screen.findByText("not known")).toBeInTheDocument();

    await act(async () => answer(lineageOf("new")));
    expect(await screen.findByText("new")).toBeInTheDocument();
  });

  /**
   * Delete opened from a list has no page reading the object: the lineage it
   * found in the cache could be thirty seconds old and about the object
   * before this one. Fails if the dialog trusts a cached lineage without
   * asking again, or asks the index about the cached uid while it does.
   */
  it("has its lineage asked again each time Delete opens", async () => {
    const client = testQueryClient();
    client.setQueryData(
      queryKeys.lineage("apps", "deployments", "shop", "api"),
      lineageOf("old")
    );
    const asked: string[] = [];
    answers.lineage = () => Promise.resolve(lineageOf("new"));
    answers.cascade = (uid) => {
      asked.push(uid);
      return Promise.resolve({
        takes: [],
        notRead: NOTHING_UNREAD,
        holds: null,
      });
    };
    await renderWithRouter(
      <CascadePreview kind="Deployment" name="api" namespace="shop" />,
      { client }
    );
    await waitFor(() => expect(asked).toContain("new"));
    expect(asked).not.toContain("old");
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
    const unwatched = (
      kind: string,
      says: "unlistable" | "unwatchable" | "skipped"
    ) => ({
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
            ...["Binding", "TokenReview"].map((kind) =>
              unwatched(kind, "unlistable")
            ),
            unwatched("ComponentStatus", "unwatchable"),
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
    expect(chipOf("ComponentStatus")).toHaveTextContent("cannot be watched");
    expect(chipOf("Binding")).toHaveTextContent("cannot be listed");
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
