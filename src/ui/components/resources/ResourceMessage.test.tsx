import type { ReactNode } from "react";
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

import { ResourceMessage } from "./ResourceMessage";

const wrap = (ui: ReactNode) =>
  render(<MemoryRouter initialEntries={["/events"]}>{ui}</MemoryRouter>);

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
  it("offers the object the message names", () => {
    const { container } = wrap(
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
      "/replicasets/k8s-gui-test/meshed-demo-65d47b457f"
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
  it("keeps a message that names three objects readable", () => {
    const { container } = wrap(
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
   * `isRoutableKind` is the only authority on where the app can go. A mention
   * it rejects has to come out as the text it always was — a tinted name with
   * a glyph and no destination reads as a link that broke.
   */
  it("renders a mention it cannot route as plain text", () => {
    const message = "Created pod: bare-rs-demo-s64zk";
    const { container } = wrap(<ResourceMessage message={message} />);
    expect(visible(container)).toBe(message);
    expect(screen.queryByRole("link")).toBeNull();
    expect(screen.queryByTestId("resource-ref-icon")).toBeNull();
  });

  /** A message that names nothing must be untouched, glyphs included. */
  it("leaves a message that names nothing alone", () => {
    const message =
      "0/2 nodes are available: 2 Insufficient memory. preemption: 0/2 nodes are available: 2 No preemption victims found for incoming pod.";
    const { container } = wrap(
      <ResourceMessage message={message} subject={IN_TEST_NS} />
    );
    expect(visible(container)).toBe(message);
    expect(screen.queryByRole("link")).toBeNull();
  });

  /** The image references this surface already offered still work. */
  it("still offers the image a message labels", () => {
    wrap(
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
});
