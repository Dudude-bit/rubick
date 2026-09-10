import { beforeEach, describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";

import { parseAlert } from "@/lib/alerts";
import { useAlertArrivalStore } from "@/stores/alertArrivalStore";
import { AlertBanner } from "./AlertBanner";

const ALERT = `[FIRING:1] KubePodCrashLooping (shop critical)
Labels:
 - alertname = KubePodCrashLooping
 - namespace = shop
 - pod = payments-7b6d9c5f4-x8k2p
Annotations:
 - description = Pod shop/payments-7b6d9c5f4-x8k2p is in waiting state (reason: "CrashLoopBackOff").
Started: 2026-09-10 03:14:22 UTC`;

const at = {
  kind: "Pod",
  name: "payments-7b6d9c5f4-x8k2p",
  namespace: "shop",
};

beforeEach(() => {
  useAlertArrivalStore.setState({ reading: parseAlert(ALERT), at });
});

describe("what the alert said, on the object's own page", () => {
  /**
   * The whole point. An alert is a claim somebody's rule made at a moment
   * that has passed, and this pod recovered eleven minutes after it fired.
   * Redrawing those words as the pod's state sends a person hunting a crash
   * loop that ended before they woke up.
   */
  it("keeps the alert's words apart from what the app read itself", () => {
    render(<AlertBanner {...at} namespace="shop" now={<span>Running</span>} />);

    expect(screen.getByText(/is in waiting state/)).toBeInTheDocument();
    expect(
      screen.getByText(/This app has not checked them/)
    ).toBeInTheDocument();
    expect(screen.getByText(/What this app read just now/)).toBeInTheDocument();
    expect(screen.getByText("Running")).toBeInTheDocument();
  });

  /**
   * Silence is not health. A page that has not read yet, and one whose read
   * was refused, both have to say so where the alert's claim is sitting
   * unanswered.
   */
  it("says it has not read the object yet rather than leaving the claim unanswered", () => {
    render(<AlertBanner {...at} namespace="shop" />);
    expect(screen.getByText(/still reading/i)).toBeInTheDocument();
  });

  it("says the cluster refused instead of drawing the object as fine", () => {
    render(
      <AlertBanner
        {...at}
        namespace="shop"
        now={<span>Running</span>}
        error="pods is forbidden"
      />
    );
    expect(screen.getByText(/could not read/i)).toBeInTheDocument();
    expect(screen.queryByText("Running")).not.toBeInTheDocument();
  });

  it("stays on the object the reader opened from the alert", () => {
    const { container } = render(
      <AlertBanner
        kind="Pod"
        name="carts-6c7d8f9b4-qq11p"
        namespace="shop"
        now={<span>Running</span>}
      />
    );
    expect(container).toBeEmptyDOMElement();
  });
});
