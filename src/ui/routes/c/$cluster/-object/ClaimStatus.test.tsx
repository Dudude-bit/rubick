import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { screen } from "@testing-library/react";

const answer = vi.hoisted(() => ({ events: [] as unknown[] }));
vi.mock("@/lib/commands", () => ({
  commands: {
    listEvents: () => Promise.resolve(answer.events),
    listStorageClasses: () => Promise.resolve([]),
  },
}));

import type {
  EventInfo,
  PersistentVolumeClaimInfo,
  StorageClassInfo,
} from "@/generated/types";
import { useWindowActivity } from "@/lib/window-activity";
import { renderWithProviders, renderWithRouter } from "@/test/render";
import {
  ClaimClassCell,
  ClaimStatusCell,
  ClaimSummary,
  ClaimVolume,
  ClaimVolumeCell,
} from "./ClaimStatus";

const claim: PersistentVolumeClaimInfo = {
  uid: "u1",
  name: "orphan-claim",
  namespace: "cause-demo",
  status: "Pending",
  volume: null,
  capacity: null,
  accessModes: ["ReadWriteOnce"],
  storageClass: "fast-ssd-missing",
  labels: {},
  annotations: {},
  createdAt: "2026-10-13T12:00:00Z",
};

const localPath: StorageClassInfo = {
  name: "local-path",
  uid: "local-path",
  provisioner: "rancher.io/local-path",
  reclaimPolicy: "Delete",
  volumeBindingMode: "WaitForFirstConsumer",
  allowVolumeExpansion: false,
  isDefault: true,
  parameters: {},
  labels: {},
  annotations: {},
  createdAt: null,
};

beforeEach(() => {
  useWindowActivity.setState({ visible: true });
  answer.events = [];
});

describe("a claim's row in the list", () => {
  /**
   * Live, orphan-claim's row said a blue Pending and nothing else for two
   * days. Fails if the row stops saying the class is missing after the
   * badge, in red, or says a wait by design in anything but the wait's blue.
   */
  it("says why it is Pending after the badge, in the colour of the cause", () => {
    const { unmount } = renderWithProviders(
      <ClaimStatusCell
        claim={claim}
        reads={{ classes: [localPath], volumes: [] }}
      />
    );
    const missing = screen.getByTestId("claim-cause");
    expect(missing.textContent).toBe(
      "StorageClass fast-ssd-missing does not exist, so nothing will provision a volume for it."
    );
    expect(missing.className).toContain("text-err");
    unmount();

    renderWithProviders(
      <ClaimStatusCell
        claim={{ ...claim, storageClass: "local-path" }}
        reads={{ classes: [localPath], volumes: [] }}
      />
    );
    expect(screen.getByTestId("claim-cause").className).toContain("text-info");
  });

  /** Fails if the row's Storage class cell links a class the cluster lacks, as if it could be opened. */
  it("marks a class the cluster lacks rather than linking it", () => {
    renderWithProviders(
      <ClaimClassCell
        claim={claim}
        reads={{ classes: [localPath], volumes: [] }}
      />
    );
    const named = screen.getByText("fast-ssd-missing");
    expect(named.closest("a")).toBeNull();
    expect(named.parentElement?.className).toContain("text-err");
  });

  /** Fails if the row's Volume cell links a volume the cluster lacks, as if it could be opened, or stops linking one it has. */
  it("marks a volume the cluster lacks rather than linking it", async () => {
    const asks = { ...claim, volume: "pv-that-is-not-there" };
    const { unmount } = renderWithProviders(
      <ClaimVolumeCell claim={asks} reads={{ classes: [], volumes: [] }} />
    );
    const named = screen.getByText("pv-that-is-not-there");
    expect(named.closest("a")).toBeNull();
    expect(screen.getByTestId("claim-missing").className).toContain("text-err");
    unmount();

    await renderWithRouter(
      <ClaimVolumeCell
        claim={asks}
        reads={{ classes: [], volumes: "unread" }}
      />
    );
    expect(screen.queryByTestId("claim-missing")).toBeNull();
    expect(
      screen.getByText("pv-that-is-not-there").closest("a")
    ).not.toBeNull();
  });

  /** Fails if a row whose classes are still being read guesses a cause. */
  it("says no cause while the classes are still being read", () => {
    renderWithProviders(
      <ClaimStatusCell
        claim={claim}
        reads={{ classes: "reading", volumes: [] }}
      />
    );
    expect(screen.queryByTestId("claim-cause")).toBeNull();
    expect(screen.getByText("Pending")).toBeTruthy();
  });
});

describe("a claim's Volume row on its page and peek", () => {
  /** Fails if the row links a volume the cause found missing instead of saying it does not exist. */
  it("says a volume the cluster lacks does not exist", () => {
    renderWithProviders(
      <ClaimVolume
        claim={{ ...claim, volume: "pv-that-is-not-there" }}
        cause={{ says: "volumeMissing", volume: "pv-that-is-not-there" }}
      />
    );
    const line = screen.getByTestId("claim-missing");
    expect(line).toHaveTextContent("pv-that-is-not-there does not exist");
    expect(line.querySelector("a")).toBeNull();
  });
});

describe("a claim's summary", () => {
  /**
   * The provisioner wrote why it failed nineteen hundred times, on the
   * claim's events and nowhere a reader looks first. Fails if the summary
   * stops quoting the newest warning under the cause.
   */
  it("quotes the provisioner's newest warning under the cause", async () => {
    answer.events = [
      {
        type: "Warning",
        reason: "ProvisioningFailed",
        message: 'storageclass.storage.k8s.io "fast-ssd-missing" not found',
        involvedObject: {
          kind: "PersistentVolumeClaim",
          name: "orphan-claim",
          namespace: "cause-demo",
          uid: "u1",
        },
      } as EventInfo,
    ];
    renderWithProviders(
      <ClaimSummary
        claim={claim}
        cause={{ says: "classMissing", name: "fast-ssd-missing" }}
      />
    );
    expect(
      screen.getByText(
        "StorageClass fast-ssd-missing does not exist, so nothing will provision a volume for it."
      )
    ).toBeTruthy();
    const label = await screen.findByText(
      "Its newest warning, ProvisioningFailed:"
    );
    expect(label.parentElement).toHaveTextContent(
      'storageclass.storage.k8s.io "fast-ssd-missing" not found'
    );
  });
});
