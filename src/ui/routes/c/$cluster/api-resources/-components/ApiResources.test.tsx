import { fireEvent, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type { ApiCatalog } from "@/generated/types";
import { useClusterStore } from "@/stores/clusterStore";
import { renderWithRouter } from "@/test/render";

const catalog = vi.hoisted(() => ({
  answer: null as unknown as () => Promise<ApiCatalog>,
}));

vi.mock("@/lib/commands", () => ({
  commands: { listApiCatalog: () => catalog.answer() },
}));

const { ApiResources } = await import("./ApiResources");

const entry = (
  group: string,
  kind: string,
  plural: string,
  namespaced = true,
  verbs = ["get", "list", "watch"]
) => ({
  group,
  version: "v1",
  kind,
  plural,
  namespaced,
  verbs,
  shortNames: [],
});

const SERVED: ApiCatalog = {
  entries: [
    entry("coordination.k8s.io", "Lease", "leases"),
    entry("", "Pod", "pods"),
    entry("", "ServiceAccount", "serviceaccounts"),
    entry("scheduling.k8s.io", "PriorityClass", "priorityclasses", false),
    entry("authentication.k8s.io", "TokenReview", "tokenreviews", false, [
      "create",
    ]),
    entry("events.k8s.io", "Event", "events"),
  ],
  unread: [
    {
      group: "metrics.k8s.io",
      code: "KUBE_API",
      message: "the server is currently unable to handle the request",
    },
  ],
};

const draw = () =>
  renderWithRouter(<ApiResources />, {
    at: "/c/prod/api-resources",
    route: "/c/$cluster/api-resources",
  });

const link = (name: string) => screen.getByRole("link", { name });

beforeEach(() => {
  catalog.answer = () => Promise.resolve(SERVED);
  useClusterStore.setState({ isConnected: true, currentContext: "prod" });
});

describe("the API resources page", () => {
  /** Every served kind is a way to its list, its own page where it has one. */
  it("links each kind to its list", async () => {
    await draw();
    expect(await screen.findByRole("link", { name: "Lease" })).toHaveAttribute(
      "href",
      "/c/prod/leases.coordination.k8s.io"
    );
    expect(link("Pod")).toHaveAttribute("href", "/c/prod/pods");
    expect(link("ServiceAccount")).toHaveAttribute(
      "href",
      "/c/prod/serviceaccounts"
    );
    expect(link("Event")).toHaveAttribute(
      "href",
      "/c/prod/events.events.k8s.io"
    );
  });

  it("groups kinds by API group, core first", async () => {
    await draw();
    const titles = (await screen.findAllByRole("region")).map((region) =>
      region.getAttribute("aria-label")
    );
    expect(titles.slice(0, 2)).toEqual(["core", "authentication.k8s.io"]);
  });

  it("says a kind's scope and whether it can be listed", async () => {
    await draw();
    const priority = (await screen.findByText("PriorityClass")).closest("li")!;
    expect(within(priority).getByText("cluster-wide")).toBeInTheDocument();
    const review = screen.getByText("TokenReview").closest("li")!;
    expect(within(review).getByText("cannot be listed")).toBeInTheDocument();
    expect(within(review).queryByRole("link")).toBeNull();
  });

  /** A group discovery did not answer is named with why, never left out. */
  it("keeps an unread group on the page with its reason", async () => {
    await draw();
    const metrics = await screen.findByRole("region", {
      name: "metrics.k8s.io",
    });
    expect(metrics).toHaveTextContent("Discovery did not answer");
    expect(metrics).toHaveTextContent("unable to handle the request");
  });

  it("narrows to the kinds the filter names", async () => {
    await draw();
    fireEvent.change(await screen.findByRole("textbox"), {
      target: { value: "lease" },
    });
    expect(link("Lease")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Pod" })).toBeNull();
  });

  /** No match among the groups that answered is not "this cluster has none". */
  it("does not call a miss final while a group did not answer", async () => {
    await draw();
    fireEvent.change(await screen.findByRole("textbox"), {
      target: { value: "podmetrics" },
    });
    expect(
      screen.getByText(/No kind in the groups that answered matches podmetrics/)
    ).toBeInTheDocument();
    expect(
      screen.getByRole("region", { name: "metrics.k8s.io" })
    ).toBeInTheDocument();
  });

  it("says what failed when the catalogue could not be read", async () => {
    catalog.answer = () =>
      Promise.reject({ code: "PERMISSION_DENIED", message: "forbidden" });
    await draw();
    expect(
      await screen.findByText("Could not read what this cluster serves")
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Try again" })
    ).toBeInTheDocument();
  });
});

describe("a kind name longer than its row", () => {
  /** Fails if a cut kind name can no longer be read whole on hover. */
  it("keeps the whole name on hover", async () => {
    catalog.answer = () => Promise.resolve(SERVED);
    await draw();
    expect(await screen.findByText("PriorityClass")).toHaveAttribute(
      "title",
      "PriorityClass"
    );
  });

  /**
   * ValidatingAdmissionPolicyBinding's row ended in
   * "admissionregistration.k8s.io/…", the version cut and the group said
   * again under its own heading. Fails if the row repeats the group.
   */
  it("says the version beside the kind, with the whole apiVersion on hover", async () => {
    catalog.answer = () => Promise.resolve(SERVED);
    await draw();
    const row = (await screen.findByText("Lease")).closest("li")!;
    const version = within(row).getByTitle("coordination.k8s.io/v1");
    expect(version).toHaveTextContent(/^v1$/);
  });
});
