import type { ReactNode } from "react";
import { describe, expect, it } from "vite-plus/test";
import { screen } from "@testing-library/react";

import { Prose, ResourceMessage } from "./ResourceMessage";
import { renderWithRouter } from "@/test/render";

const wrap = (ui: ReactNode) =>
  renderWithRouter(<>{ui}</>, {
    at: "/c/prod/events",
    route: "/c/$cluster/$",
  });

const IN_TEST_NS = { namespace: "k8s-gui-test" };

/** What the reader sees: the kind a reference hides for a screen reader is
 *  not part of the sentence on screen. */
const visible = (container: HTMLElement) => {
  const copy = container.cloneNode(true) as HTMLElement;
  copy.querySelectorAll(".sr-only").forEach((node) => node.remove());
  return copy.textContent;
};

describe("ResourceMessage", () => {
  /**
   * The event from the screenshot. If the name stops being an anchor there is
   * no way from the event that scaled a revision to the revision it scaled.
   */
  it("offers the object the message names", async () => {
    const { container } = await wrap(
      <ResourceMessage
        message="Scaled up replica set meshed-demo-65d47b457f to 1"
        subject={{
          kind: "Deployment",
          name: "meshed-demo",
          namespace: "k8s-gui-test",
        }}
      />
    );
    const link = screen.getByRole("link", {
      name: "ReplicaSet meshed-demo-65d47b457f",
    });
    expect(link).toHaveAttribute(
      "href",
      "/c/prod/replicasets/k8s-gui-test/meshed-demo-65d47b457f"
    );
    // The prose already said "replica set"; repeating it inside the
    // reference is what stops the row reading as a sentence.
    expect(visible(container)).toBe(
      "Scaled up replica set meshed-demo-65d47b457f to 1"
    );
  });

  /**
   * Three objects in one sentence, each reachable, and the words between them
   * untouched. A message that turns into a row of chips is not a message.
   */
  it("keeps a message that names three objects readable", async () => {
    const { container } = await wrap(
      <ResourceMessage
        message="create Claim data-stateful-demo-1 Pod stateful-demo-1 in StatefulSet stateful-demo success"
        subject={{
          kind: "StatefulSet",
          name: "stateful-demo",
          namespace: "k8s-gui-test",
        }}
      />
    );
    expect(visible(container)).toBe(
      "create Claim data-stateful-demo-1 Pod stateful-demo-1 in StatefulSet stateful-demo success"
    );
    expect(screen.getAllByRole("link")).toHaveLength(2);
    // The StatefulSet is the object this message is about, so it is the one
    // name here that is not offered: you are already reading it.
    expect(
      screen.queryByRole("link", { name: "StatefulSet stateful-demo" })
    ).toBeNull();
  });

  /**
   * `objectLink` is the only authority on where the app can go. A mention
   * it rejects has to come out as the text it always was — a tinted name with
   * a glyph and no destination reads as a link that broke.
   */
  it("renders a mention it cannot route as plain text", async () => {
    const message = "Created pod: bare-rs-demo-s64zk";
    const { container } = await wrap(<ResourceMessage message={message} />);
    expect(visible(container)).toBe(message);
    expect(screen.queryByRole("link")).toBeNull();
    expect(screen.queryByTestId("resource-ref-icon")).toBeNull();
  });

  /** A message that names nothing must be untouched, glyphs included. */
  it("leaves a message that names nothing alone", async () => {
    const message =
      "0/2 nodes are available: 2 Insufficient memory. preemption: 0/2 nodes are available: 2 No preemption victims found for incoming pod.";
    const { container } = await wrap(
      <ResourceMessage message={message} subject={IN_TEST_NS} />
    );
    expect(visible(container)).toBe(message);
    expect(screen.queryByRole("link")).toBeNull();
  });

  /** The image references this surface already offered still work. */
  it("still offers the image a message labels", async () => {
    await wrap(
      <ResourceMessage
        message='Back-off pulling image "registry.invalid/nope:v9"'
        subject={IN_TEST_NS}
      />
    );
    expect(
      screen.getByRole("button", {
        name: "Copy image registry.invalid/nope:v9",
      })
    ).toBeInTheDocument();
  });

  /**
   * Marco at 1400 read "in Secret team-" at a line's end and
   * "checkout/checkout-db" on the next. Fails if a name the cluster wrote can
   * break inside, or holding it together changes a character of the text.
   */
  it("never breaks a name inside the cluster's sentence", async () => {
    const message =
      "couldn't find key DB_PASSWORD in Secret team-checkout/checkout-db";
    const { container } = await wrap(
      <ResourceMessage message={message} subject={IN_TEST_NS} />
    );
    expect(screen.getByText("team-checkout/checkout-db")).toHaveClass(
      "inline-block"
    );
    expect(screen.getByText("DB_PASSWORD")).toHaveClass("inline-block");
    expect(visible(container)).toBe(message);
  });

  /**
   * Marco in Russian at 1024: a line ended on a lone opening quote and the
   * ReplicaSet's name began the next. Fails if the quotes around a reference
   * stop travelling with it, or are drawn twice.
   */
  it("keeps the quotes with the reference they enclose", async () => {
    const message =
      'ReplicaSet "stuck-demo-5b4cdbdd65" has timed out progressing.';
    const { container } = await wrap(
      <ResourceMessage
        message={message}
        subject={{ kind: "Deployment", name: "stuck-demo", ...IN_TEST_NS }}
      />
    );
    const kept = screen
      .getByRole("link", { name: "ReplicaSet stuck-demo-5b4cdbdd65" })
      .closest(".inline-block") as HTMLElement;
    expect(visible(kept)).toBe('"stuck-demo-5b4cdbdd65"');
    expect(visible(container)).toBe(message);
  });

  /** A cut line has no break to prevent; fails if one holds its words in boxes the ellipsis would hide whole. */
  it("holds nothing together on a line that is cut rather than wrapped", async () => {
    const { container } = await wrap(
      <ResourceMessage
        message="couldn't find key DB_PASSWORD in Secret team-checkout/checkout-db"
        oneLine
      />
    );
    expect(container.querySelector(".inline-block")).toBeNull();
  });
});

describe("Prose", () => {
  /** Lena's Service rows break "app=topology-" from "demo"; fails if a selector or a ratio in the app's own sentence can break inside, or loses the comma after it. */
  it("keeps selectors and ratios whole with their punctuation", async () => {
    const { container } = await wrap(
      <Prose text="2 pods carry app=topology-demo, and 0/2 are ready" />
    );
    expect(screen.getByText("app=topology-demo,")).toHaveClass("inline-block");
    expect(screen.getByText("0/2")).toHaveClass("inline-block");
    expect(container).toHaveTextContent(
      "2 pods carry app=topology-demo, and 0/2 are ready"
    );
  });
});
