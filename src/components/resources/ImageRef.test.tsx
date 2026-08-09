import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";

import { ImageRef } from "./ImageRef";
import { EventRows } from "./detail-blocks";
import type { EventInfo } from "@/generated/types";

const openInBrowser = vi.hoisted(() => vi.fn(async () => {}));
const toast = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/plugin-shell", () => ({ open: openInBrowser }));
vi.mock("@/components/ui/use-toast", () => ({ toast }));

beforeEach(() => {
  openInBrowser.mockReset();
  openInBrowser.mockResolvedValue(undefined);
  toast.mockReset();
});

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

  it("offers the registry from inside the sentence too", () => {
    wrap(
      <EventRows events={[event('Pulling image "quay.io/ceph/ceph:v18"')]} />
    );
    expect(
      screen.getByRole("link", { name: "Open ceph/ceph:v18 on Quay" })
    ).toBeInTheDocument();
  });
});

describe("the way out to a registry", () => {
  it("names the destination rather than saying 'open in browser'", () => {
    wrap(<ImageRef image="nginx:1.25" />);
    const link = screen.getByRole("link", {
      name: "Open nginx:1.25 on Docker Hub",
    });
    expect(link).toHaveAttribute(
      "href",
      "https://hub.docker.com/_/nginx/tags?name=1.25"
    );
    expect(link).toHaveAttribute("title", "Open nginx:1.25 on Docker Hub");
  });

  it("sends a namespaced image somewhere else than an official one", () => {
    wrap(<ImageRef image="rancher/mirrored-pause:3.6" />);
    expect(
      screen.getByRole("link", {
        name: "Open rancher/mirrored-pause:3.6 on Docker Hub",
      })
    ).toHaveAttribute(
      "href",
      "https://hub.docker.com/r/rancher/mirrored-pause/tags?name=3.6"
    );
  });

  it("offers nothing for a registry with no page to open", () => {
    wrap(<ImageRef image="registry.k8s.io/kube-apiserver:v1.31.0" />);
    expect(screen.queryByRole("link")).toBeNull();
    // The image is still there to copy; only the way out is withheld.
    expect(screen.getByRole("button")).toHaveTextContent(
      "registry.k8s.io/kube-apiserver:v1.31.0"
    );
  });

  it("hands the URL to the system browser without navigating the app or the row", async () => {
    const rowClick = vi.fn();
    wrap(
      <div onClick={rowClick}>
        <ImageRef image="quay.io/prometheus/prometheus:v2.45.0" />
      </div>
    );
    const link = screen.getByRole("link");
    // A webview that follows this href loses the app, so the click must be
    // taken over entirely — `defaultPrevented` is what proves it was.
    const click = new MouseEvent("click", { bubbles: true, cancelable: true });
    link.dispatchEvent(click);
    expect(click.defaultPrevented).toBe(true);
    expect(openInBrowser).toHaveBeenCalledWith(
      "https://quay.io/repository/prometheus/prometheus?tab=tags&tag=v2.45.0"
    );
    expect(rowClick).not.toHaveBeenCalled();
  });

  it("says so, and leaves the address behind, when no browser opens", async () => {
    openInBrowser.mockRejectedValue(new Error("no browser"));
    const write = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText: write } });
    wrap(<ImageRef image="nginx:1.25" />);
    await userEvent.click(screen.getByRole("link"));
    expect(write).toHaveBeenCalledWith(
      "https://hub.docker.com/_/nginx/tags?name=1.25"
    );
    expect(toast).toHaveBeenCalledWith(
      expect.objectContaining({ variant: "destructive" })
    );
  });
});
