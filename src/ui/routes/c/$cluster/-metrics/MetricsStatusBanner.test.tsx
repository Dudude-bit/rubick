import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { act, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient } from "@tanstack/react-query";

vi.mock("@/lib/commands", () => ({
  commands: {
    recheckMetrics: vi.fn(async () => undefined),
    forgetDiscovery: vi.fn(async () => undefined),
  },
}));

import { commands } from "@/lib/commands";

import { renderWithRouter } from "@/test/render";
import { useClusterStore } from "@/stores/clusterStore";
import { useMetricsNoticeStore } from "@/stores/metricsNoticeStore";
import { queryKeys } from "@/lib/query-keys";
import { MetricsStatusBanner } from "./MetricsStatusBanner";
import { ListUnread } from "../-list/list-unread";

const available = { status: "available" as const, message: null };
const notInstalled = {
  status: "notInstalled" as const,
  message: "404 page not found",
};

const bannerOf = (title: string) =>
  screen.getByText(title).closest('[role="status"]') as HTMLElement;

beforeEach(() => {
  vi.mocked(commands.recheckMetrics).mockClear();
  useMetricsNoticeStore.setState({ hidden: {} });
  useClusterStore.setState({ currentContext: "acme-staging" });
});

describe("MetricsStatusBanner", () => {
  /**
   * One namespace of a selection refused beside one that answered leaves the
   * status "available". Without the unread namespace named, its pods' blank
   * samples looked like "not scraped yet" and no banner said otherwise.
   */
  it("names a namespace whose metrics were refused beside ones that answered", async () => {
    await renderWithRouter(
      <MetricsStatusBanner
        status={available}
        unread={[
          {
            namespace: "staging",
            code: "PERMISSION_DENIED",
            message:
              'pods.metrics.k8s.io is forbidden in the namespace "staging"',
          },
        ]}
      />
    );
    expect(
      screen.getByText("Could not read pod metrics in staging.")
    ).toBeInTheDocument();
  });

  /** Every namespace answered: there is nothing to say. */
  it("says nothing when every namespace answered", async () => {
    const { container } = await renderWithRouter(
      <MetricsStatusBanner status={available} unread={[]} />
    );
    expect(container).toBeEmptyDOMElement();
  });

  /**
   * A newcomer read "404 page not found" as the app being broken. Fails if
   * the server's words reach the visible line, or if a missing install is
   * drawn in the red a broken workload wears.
   */
  it("says metrics-server is missing in words, with the 404 folded away", async () => {
    await renderWithRouter(<MetricsStatusBanner status={notInstalled} />);

    const banner = bannerOf(
      "metrics-server is not installed, so CPU and memory are not shown"
    );
    expect(screen.getByText("404 page not found")).not.toBeVisible();
    expect(banner.className).not.toContain("border-err");
  });

  /** Fails if a refusal goes back to the error tone it cannot be fixed from. */
  it("draws a refusal calmly, not as an error", async () => {
    await renderWithRouter(
      <MetricsStatusBanner status={{ status: "forbidden", message: null }} />
    );
    const banner = bannerOf(
      "Metrics are not readable with this access, so CPU and memory are not shown"
    );
    expect(banner.className).toContain("border-dashed");
    expect(banner.className).not.toContain("border-err");
    expect(banner.querySelector("svg")).toHaveClass("lucide-lock");
  });

  /**
   * The metrics notice was the one refusal with no age and no rule to ask
   * for. Fails if either is missing from a refusal whose message names a rule.
   */
  it("says since when a refusal stands and offers the rule to ask for", async () => {
    await renderWithRouter(
      <MetricsStatusBanner
        status={{
          status: "forbidden",
          message:
            'pods.metrics.k8s.io is forbidden: User "jane@example.com" cannot list resource "pods" in API group "metrics.k8s.io" at the cluster scope',
        }}
      />
    );
    await waitFor(() =>
      expect(screen.getByTestId("metrics-since")).toHaveTextContent(
        /^Refused since \d/
      )
    );
    expect(
      screen.getByRole("button", { name: "Copy the rule to ask for" })
    ).toBeInTheDocument();
  });

  /** The notice sat at 68ch above a full-width refusal line; fails if it takes a width of its own again. */
  it("spans the content column like every other notice above a list", async () => {
    await renderWithRouter(
      <MetricsStatusBanner status={{ status: "forbidden", message: null }} />
    );
    const banner = bannerOf(
      "Metrics are not readable with this access, so CPU and memory are not shown"
    );
    expect(banner.className).not.toMatch(/max-w-/);
  });

  /** Fails if a refusal with no parseable rule invents a copy action. */
  it("offers no rule when the refusal names none", async () => {
    await renderWithRouter(
      <MetricsStatusBanner status={{ status: "forbidden", message: "nope" }} />
    );
    expect(
      screen.queryByRole("button", { name: "Copy the rule to ask for" })
    ).toBeNull();
  });

  /**
   * The banner sat on every page with no way to close it. Fails if hiding it
   * does not hold for the cluster, or if it hides it for every cluster.
   */
  it("can be put away for one cluster and stays away there", async () => {
    const { unmount } = await renderWithRouter(
      <MetricsStatusBanner status={notInstalled} />
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Hide for this cluster" })
    );
    expect(screen.queryByText(/metrics-server is not installed/)).toBeNull();
    unmount();

    const again = await renderWithRouter(
      <MetricsStatusBanner status={notInstalled} />
    );
    expect(screen.queryByText(/metrics-server is not installed/)).toBeNull();
    again.unmount();

    useClusterStore.setState({ currentContext: "acme-prod" });
    await renderWithRouter(<MetricsStatusBanner status={notInstalled} />);
    expect(
      bannerOf(
        "metrics-server is not installed, so CPU and memory are not shown"
      )
    ).toBeInTheDocument();
  });

  /**
   * Hiding is remembered per cluster for good, so a metrics failure put away
   * stayed silent while rows kept showing reduced data. Fails if a failing
   * metrics read can be hidden, or an old hidden mark still hides it.
   */
  it("cannot be put away while the metrics read is failing", async () => {
    useMetricsNoticeStore.setState({ hidden: { "acme-staging": ["error"] } });
    await renderWithRouter(
      <MetricsStatusBanner status={{ status: "error", message: "502" }} />
    );
    expect(
      screen.getByText(
        "The metrics API is failing, so CPU and memory may be missing"
      )
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Hide for this cluster" })
    ).toBeNull();
  });

  /**
   * The backend now answers every metrics read from its five-minute memory,
   * so a retry that only refetched would read the memory back: a
   * metrics-server installed a minute ago would still say "not installed".
   * The retry is every could-not-look notice's, in its words.
   */
  it("makes its retry forget the remembered answer before it reads", async () => {
    const client = new QueryClient();
    const refetch = vi.spyOn(client, "refetchQueries");
    await renderWithRouter(<MetricsStatusBanner status={notInstalled} />, {
      client,
    });
    await userEvent.click(
      screen.getByRole("button", { name: "Try the read again" })
    );
    await waitFor(() => expect(refetch).toHaveBeenCalled());
    expect(commands.recheckMetrics).toHaveBeenCalledTimes(1);
    expect(
      vi.mocked(commands.recheckMetrics).mock.invocationCallOrder[0]
    ).toBeLessThan(refetch.mock.invocationCallOrder[0]);
  });

  /**
   * The banner drew "Checking…" above a list and then vanished once the
   * read answered, moving every row 70px twice. Fails if a notice takes room
   * while the first read is still running, or never comes once it ends.
   */
  it("takes no room while the metrics read is still on its way, and says so once it has answered", async () => {
    const client = new QueryClient();
    let answer: () => void = () => {};
    const reading = client.fetchQuery({
      queryKey: queryKeys.metrics.all(),
      queryFn: () => new Promise<null>((done) => (answer = () => done(null))),
    });
    const { container } = await renderWithRouter(
      <MetricsStatusBanner status={notInstalled} />,
      { client }
    );
    expect(container).toBeEmptyDOMElement();
    answer();
    await reading;
    expect(
      await screen.findByText(
        "metrics-server is not installed, so CPU and memory are not shown"
      )
    ).toBeInTheDocument();
  });

  /**
   * The banner sits above a list, and a peek opening beside the list made its
   * sentences wrap onto more lines, moving every row under the pointer. Fails
   * if its title or its sentence takes more lines beside a peek than before.
   */
  it("keeps its lines while a peek opens beside the list", async () => {
    const rects = vi
      .spyOn(HTMLElement.prototype, "getClientRects")
      .mockImplementation(() => [new DOMRect()] as unknown as DOMRectList);
    const { router } = await renderWithRouter(
      <MetricsStatusBanner status={notInstalled} />,
      { at: "/c/prod/pods" }
    );
    await act(() =>
      router.navigate({ href: "/c/prod/pods?peek=pods%2Fns%2Fa-1" })
    );
    const title = screen.getByText(
      "metrics-server is not installed, so CPU and memory are not shown"
    );
    expect(title.style.webkitLineClamp).toBe("1");
    expect(
      screen.getByText(/^Installing it is a job for whoever runs this cluster/)
        .style.webkitLineClamp
    ).toBe("1");
    rects.mockRestore();
  });

  /**
   * A refusal had a close X its neighbour, the list's own refusal, did not,
   * and once put away the lock cells under it went unexplained. Fails if a
   * refused metrics read can be put away.
   */
  it("cannot put away a refusal", async () => {
    await renderWithRouter(
      <MetricsStatusBanner status={{ status: "forbidden", message: null }} />
    );
    expect(
      screen.getByRole("button", { name: "Try the read again" })
    ).toBeVisible();
    expect(
      screen.queryByRole("button", { name: "Hide for this cluster" })
    ).toBeNull();
  });

  /**
   * The Deployments list kept "Metrics are not readable" for minutes while
   * the object page opened from it read live usage. Fails if another
   * reader's answer does not have the remembered refusal asked again.
   */
  it("asks again once another reader of the metrics got an answer", async () => {
    const client = new QueryClient();
    client.setQueryData(queryKeys.metrics.pods("argocd"), {
      status: available,
      data: [],
      unread: [],
    });
    await renderWithRouter(
      <MetricsStatusBanner status={{ status: "forbidden", message: null }} />,
      { client }
    );
    await waitFor(() =>
      expect(commands.recheckMetrics).toHaveBeenCalledTimes(1)
    );
  });

  /** Fails if a remembered refusal is asked again with no reader having answered. */
  it("keeps the remembered refusal while no reader has answered", async () => {
    await renderWithRouter(
      <MetricsStatusBanner status={{ status: "forbidden", message: null }} />
    );
    expect(commands.recheckMetrics).not.toHaveBeenCalled();
  });

  /**
   * Over a list that was refused, the metrics frame stacked full width over
   * the list's own: two notices for one empty page. Fails if the metrics
   * notice is drawn where the list under it was not read.
   */
  it("says nothing over a list that was not read", async () => {
    const { container } = await renderWithRouter(
      <ListUnread.Provider value>
        <MetricsStatusBanner status={{ status: "forbidden", message: null }} />
      </ListUnread.Provider>
    );
    expect(container).toBeEmptyDOMElement();
  });
});
