import { beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { parseAlert } from "@/lib/alerts";
import { useClusterStore } from "@/stores/clusterStore";
import { renderWithRouter } from "@/test/render";
import { AlertReadingPanel, type AlertTarget } from "./AlertReadingPanel";

const DEPLOYMENT = `[FIRING:1] KubeDeploymentReplicasMismatch (shop warning)
Labels:
 - alertname = KubeDeploymentReplicasMismatch
 - cluster = prod-eu-1
 - deployment = checkout
 - job = kube-state-metrics
 - namespace = shop
 - pod = kube-prometheus-stack-kube-state-metrics-7d9f8c6b5-mn2kx
 - severity = warning
Annotations:
 - description = Deployment shop/checkout has not matched the expected number of replicas for longer than 15 minutes.
Started: 2026-09-10 03:41:00 UTC`;

const NO_CLUSTER = `[FIRING:1] KubePodCrashLooping (shop critical)
Labels:
 - alertname = KubePodCrashLooping
 - namespace = shop
 - pod = payments-7b6d9c5f4-x8k2p
 - severity = critical
Started: 2026-09-10 03:14:22 UTC`;

function mount(text: string, onOpen: (target: AlertTarget) => void = () => {}) {
  return renderWithRouter(
    <AlertReadingPanel reading={parseAlert(text)!} onOpen={onOpen} />,
    { at: "/c/prod-eu-1" }
  );
}

beforeEach(() => {
  useClusterStore.setState({
    contexts: [
      { name: "prod-eu-1", cluster: "", user: "" },
      { name: "staging", cluster: "", user: "" },
    ] as never,
    currentContext: "prod-eu-1",
  });
});

describe("reading an alert before anything opens", () => {
  /**
   * The failure this panel exists to prevent. A replicas-mismatch alert
   * carries a `pod` label, and that pod is kube-state-metrics: opening it
   * sends a person to read the monitoring stack's logs while their checkout
   * is down.
   */
  it("opens what the alert is about, not the pod its metrics came from", async () => {
    const opened = vi.fn();
    await mount(DEPLOYMENT, opened);

    await userEvent.click(
      screen.getByRole("button", { name: /Open Deployment checkout/ })
    );
    expect(opened).toHaveBeenCalledTimes(1);
    const target = opened.mock.calls[0][0] as AlertTarget;
    expect(target.kind).toBe("Deployment");
    expect(target.name).toBe("checkout");
    expect(target.context).toBe("prod-eu-1");
  });

  /**
   * `since` is read by the Changes tab and by nothing else, so the link has
   * to open that tab: sent alone it marked a timeline nobody had opened.
   */
  it("opens the object on the window the alert is about", async () => {
    const opened = vi.fn();
    await mount(DEPLOYMENT, opened);
    screen.getByRole("button", { name: /Open Deployment checkout/ }).click();
    const target = opened.mock.calls[0][0] as AlertTarget;
    expect(target.path).toBe(
      "/c/prod-eu-1/deployments/shop/checkout?tab=changes&since=2026-09-10T03%3A41%3A00.000Z"
    );
  });

  /**
   * `critical`, `info` and a severity nobody has heard of were all drawn in
   * the same amber, so the one that wakes somebody looked like the one that
   * does not.
   */
  it("wears the severity the alert carried", async () => {
    await mount(DEPLOYMENT.replace(/warning/g, "critical"));
    expect(screen.getByText("critical").className).toContain("text-err");

    cleanup();
    await mount(DEPLOYMENT);
    expect(screen.getByText("warning").className).toContain("text-warn");
  });

  /**
   * Nothing in the text named a kind, and the panel has to say so rather
   * than draw an empty field: the reader is deciding whether to trust it.
   */
  it("says when nothing in the text names an object", async () => {
    await mount(`[FIRING:1] SomethingIsWrong
Labels:
 - alertname = SomethingIsWrong
 - cluster = prod-eu-1
 - severity = warning`);
    expect(screen.getByText(/nothing in this text says a kind/i)).toBeVisible();
  });

  /**
   * A value recognised because it is shaped like a pod name is a guess, and
   * the warning under it is the only thing that says so.
   */
  it("warns when the object was recognised by shape alone", async () => {
    await mount(
      "[FIRING:1] KubePodCrashLooping (payments-7b6d9c5f4-x8k2p shop critical)"
    );
    expect(screen.getByText(/recognised by shape/i)).toBeVisible();
  });

  /**
   * An unread kubeconfig is not a kubeconfig with no clusters. The panel
   * offered "which of yours?" over an empty list, with Open greyed out.
   */
  it("says the clusters could not be read rather than offering none", async () => {
    useClusterStore.setState({
      contexts: [],
      currentContext: null,
      isLoading: false,
      error: "kubeconfig is not readable",
    });
    await mount(DEPLOYMENT);
    expect(screen.getByText(/could not be read/i)).toBeVisible();
  });

  /**
   * A host in a `Source:` URL is a guess this app made from a URL, and
   * "no cluster of yours is called that" credits it to the sender — sending
   * the reader to look for a cluster nobody named.
   */
  it("does not report a hostname guess as a cluster the alert named", async () => {
    await mount(`[FIRING:1] KubePodCrashLooping (shop critical)
Labels:
 - alertname = KubePodCrashLooping
 - namespace = shop
 - pod = payments-7b6d9c5f4-x8k2p
 - severity = critical
Source: https://prometheus.somewhere-else.example.com/graph`);
    expect(screen.getByText(/this is the Source host/)).toBeVisible();
    expect(screen.queryByText(/no cluster of yours is called that/)).toBeNull();
  });

  /**
   * A message that folded five alerts into one carries five sets of labels,
   * and only the first is read. A panel that says nothing about the other
   * four lets somebody open one object and believe they have seen the
   * incident.
   */
  it("says the message carried more alerts than the fields below", async () => {
    await mount(DEPLOYMENT.replace("[FIRING:1]", "[FIRING:5]"));
    expect(screen.getByText(/groups 5 alerts/)).toBeVisible();
  });

  /**
   * An HPA is a kind this app recognises in a label, and every kind the
   * registry knows opens now, on the generic object page if it has no
   * screen of its own. Fails if the alert falls back to a grey button.
   */
  it("opens an autoscaler on its own page", async () => {
    const opened = vi.fn();
    await mount(
      `[FIRING:1] KubeHpaMaxedOut (shop warning)
Labels:
 - alertname = KubeHpaMaxedOut
 - cluster = prod-eu-1
 - horizontalpodautoscaler = checkout
 - namespace = shop
 - severity = warning`,
      opened
    );
    screen
      .getByRole("button", { name: /Open HorizontalPodAutoscaler checkout/ })
      .click();
    expect((opened.mock.calls[0][0] as AlertTarget).path).toBe(
      "/c/prod-eu-1/horizontalpodautoscalers/shop/checkout"
    );
  });

  /**
   * A kind outside the registry has no address at all, so the Open button
   * can only be grey, and a disabled button with no sentence beside it
   * reads as the app being broken.
   */
  it("says why it cannot open a kind it has no page for", async () => {
    const reading = parseAlert(DEPLOYMENT)!;
    const kept = { ...reading.objects[0], kind: "ServiceAccount" };
    await renderWithRouter(
      <AlertReadingPanel
        reading={{ ...reading, objects: [kept] }}
        onOpen={() => {}}
      />,
      { at: "/c/prod-eu-1" }
    );
    expect(screen.getByText(/no page for a ServiceAccount/)).toBeVisible();
  });

  /** And a namespaced kind whose alert named no namespace says that instead. */
  it("says when nothing named the namespace to open by", async () => {
    await mount(`[FIRING:1] KubeDeploymentReplicasMismatch (warning)
Labels:
 - alertname = KubeDeploymentReplicasMismatch
 - cluster = prod-eu-1
 - deployment = checkout
 - severity = warning`);
    expect(
      screen.getByText(/names the namespace this Deployment is in/)
    ).toBeVisible();
  });

  /**
   * Only three kinds have a Changes tab. `?tab=changes` on any other page
   * names a tab that page does not have, and the reader lands on a detail
   * page with no panel open at all.
   */
  it("does not send a kind with no Changes tab to one", async () => {
    const opened = vi.fn();
    await renderWithRouter(
      <AlertReadingPanel
        reading={parseAlert(`[FIRING:1] KubePodCrashLooping (shop critical)
Labels:
 - alertname = KubePodCrashLooping
 - cluster = prod-eu-1
 - namespace = shop
 - pod = payments-7b6d9c5f4-x8k2p
 - severity = critical
Started: 2026-09-10 03:14:22 UTC`)!}
        onOpen={opened}
      />,
      { at: "/c/prod-eu-1" }
    );
    screen.getByRole("button", { name: /Open Pod payments/ }).click();
    expect((opened.mock.calls[0][0] as AlertTarget).path).toBe(
      "/c/prod-eu-1/pods/shop/payments-7b6d9c5f4-x8k2p"
    );
  });

  /**
   * `job = kube-state-metrics` is a Prometheus scrape job. Saying which keys
   * were seen and dropped is what lets a reader tell a parser that ignored
   * something from one that never saw it.
   */
  it("says which keys it saw and left alone", async () => {
    await mount(DEPLOYMENT);
    expect(screen.getByText(/names the monitoring side/)).toBeInTheDocument();
    expect(screen.getByText(/job/)).toBeInTheDocument();
  });

  it("quotes the alert rather than restating it as fact", async () => {
    await mount(DEPLOYMENT);
    expect(
      screen.getByText(/has not matched the expected number of replicas/)
    ).toBeInTheDocument();
    expect(
      screen.getByText(/This app has not checked them/)
    ).toBeInTheDocument();
  });

  /**
   * A `cluster` label naming something this kubeconfig does not have is not
   * an answer, and neither is silence. Both have to ask, or a person opens a
   * healthy copy of the thing that is down.
   */
  it("asks which cluster when the alert names none", async () => {
    const opened = vi.fn();
    await mount(NO_CLUSTER, opened);

    expect(
      screen.getByText(/nothing here names a cluster/i)
    ).toBeInTheDocument();
    const open = screen.getByRole("button", { name: /Open Pod payments/ });
    expect(open).toBeDisabled();

    await userEvent.click(screen.getByRole("radio", { name: /staging/ }));
    expect(open).toBeEnabled();
    await userEvent.click(open);
    expect((opened.mock.calls[0][0] as AlertTarget).context).toBe("staging");
  });
});
