import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { parseAlert } from "@/lib/alerts";
import { useClusterStore } from "@/stores/clusterStore";
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
  return render(
    <AlertReadingPanel reading={parseAlert(text)!} onOpen={onOpen} />
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
    mount(DEPLOYMENT, opened);

    await userEvent.click(
      screen.getByRole("button", { name: /Open Deployment checkout/ })
    );
    expect(opened).toHaveBeenCalledTimes(1);
    const target = opened.mock.calls[0][0] as AlertTarget;
    expect(target.kind).toBe("Deployment");
    expect(target.name).toBe("checkout");
    expect(target.context).toBe("prod-eu-1");
  });

  it("opens the object on the window the alert is about", () => {
    const opened = vi.fn();
    mount(DEPLOYMENT, opened);
    screen.getByRole("button", { name: /Open Deployment checkout/ }).click();
    const target = opened.mock.calls[0][0] as AlertTarget;
    expect(target.path).toBe(
      "/deployments/shop/checkout?since=2026-09-10T03:41:00.000Z"
    );
  });

  /**
   * `job = kube-state-metrics` is a Prometheus scrape job. Saying which keys
   * were seen and dropped is what lets a reader tell a parser that ignored
   * something from one that never saw it.
   */
  it("says which keys it saw and left alone", () => {
    mount(DEPLOYMENT);
    expect(screen.getByText(/names the monitoring side/)).toBeInTheDocument();
    expect(screen.getByText(/job/)).toBeInTheDocument();
  });

  it("quotes the alert rather than restating it as fact", () => {
    mount(DEPLOYMENT);
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
    mount(NO_CLUSTER, opened);

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
