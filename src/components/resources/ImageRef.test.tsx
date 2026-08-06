import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";

import { ImageRef } from "./ImageRef";
import { EventRows } from "./detail-blocks";
import type { EventInfo } from "@/generated/types";

const wrap = (ui: ReactNode) => render(<MemoryRouter>{ui}</MemoryRouter>);

const event = (message: string): EventInfo =>
  ({
    uid: "e1",
    type: "Normal",
    reason: "Pulled",
    message,
    namespace: "k8s-gui-test",
    involvedObject: { kind: "Pod", name: "cron-demo-1", namespace: null },
    count: 1,
    lastTimestamp: null,
  }) as unknown as EventInfo;

describe("ImageRef", () => {
  it("splits registry, repository and tag", () => {
    wrap(<ImageRef image="registry.invalid/nope:v9" />);
    const button = screen.getByRole("button", {
      name: "Copy image registry.invalid/nope:v9",
    });
    expect(button).toHaveTextContent("registry.invalid/nope:v9");
    expect(button.querySelector(".text-fg")).toHaveTextContent("nope");
  });

  it("shortens a digest but copies it whole", () => {
    const digest = `sha256:${"a1b2c3d4".repeat(8)}`;
    wrap(<ImageRef image={`gcr.io/project/app@${digest}`} />);
    const button = screen.getByRole("button");
    expect(button).toHaveTextContent("sha256:a1b2c3d4a1b2…");
    expect(button).not.toHaveTextContent("a1b2c3d4a1b2c3d4a1b2");
    expect(button).toHaveAttribute(
      "title",
      `Copy gcr.io/project/app@${digest}`
    );
  });

  it("still copies a reference it cannot split", () => {
    wrap(<ImageRef image="NOT A REF" />);
    expect(
      screen.getByRole("button", { name: "Copy image NOT A REF" })
    ).toHaveTextContent("NOT A REF");
  });

  it("copies the whole reference without reaching the row underneath", async () => {
    const write = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText: write } });
    const rowClick = vi.fn();
    wrap(
      <div onClick={rowClick}>
        <ImageRef image="busybox:1.36" />
      </div>
    );
    await userEvent.click(screen.getByRole("button"));
    expect(write).toHaveBeenCalledWith("busybox:1.36");
    expect(rowClick).not.toHaveBeenCalled();
  });
});

describe("an event message", () => {
  it("makes the image it names copyable and leaves the sentence alone", () => {
    wrap(
      <EventRows
        events={[
          event('Container image "busybox:1.36" already present on machine'),
        ]}
      />
    );
    expect(
      screen.getByRole("button", { name: "Copy image busybox:1.36" })
    ).toBeInTheDocument();
    expect(screen.getByText(/already present on machine/)).toBeInTheDocument();
  });

  it("keeps the copy mark out of the sentence until it confirms", async () => {
    const write = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText: write } });
    wrap(<EventRows events={[event('Pulling image "busybox:1.36"')]} />);
    expect(screen.queryByTestId("copyable-mark")).toBeNull();
    await userEvent.click(screen.getByRole("button"));
    expect(await screen.findByTestId("copyable-confirmed")).toBeInTheDocument();
  });

  it("leaves a message that names no image entirely as prose", () => {
    wrap(<EventRows events={[event("Started container cron")]} />);
    expect(screen.queryByRole("button")).toBeNull();
  });
});
