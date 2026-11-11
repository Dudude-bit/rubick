import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type {
  CrdDetailInfo,
  CustomResourceDetailInfo,
} from "@/generated/types";
import { useClusterStore } from "@/stores/clusterStore";
import { renderWithRouter } from "@/test/render";

const answers = vi.hoisted(() => ({
  crd: {} as unknown,
  crds: [] as unknown[],
  resource: {} as unknown,
  events: vi.fn((_filter: { involved_object_kind: string | null }) =>
    Promise.resolve([])
  ),
  replicaSets: vi.fn(() => Promise.resolve([])),
  connections: vi.fn(() => new Promise(() => {})),
}));

vi.mock("@/lib/commands", () => ({
  commands: {
    getCrd: () => Promise.resolve(answers.crd),
    getCustomResource: () => Promise.resolve(answers.resource),
    getCustomResourceYaml: () => Promise.resolve(""),
    listEvents: answers.events,
    getDeploymentReplicasets: answers.replicaSets,
    getResourceConnections: answers.connections,
    getAppInfo: () => Promise.resolve({ version: "5.0.0" }),
    listCrds: () => Promise.resolve(answers.crds),
    listApiCatalog: () => new Promise(() => {}),
    detectInClusterExtensions: () => Promise.resolve([]),
    detectGatewayApi: () => Promise.resolve({ installed: false, kinds: [] }),
    listGatewayClasses: () => Promise.resolve([]),
    objectLineage: () => Promise.reject({ code: "NOT_FOUND", message: "" }),
  },
}));

const { CustomResourceDetail } = await import("./CustomResourceDetail");

const crd = (group: string, kind: string, plural: string) =>
  ({ name: `${plural}.${group}`, group, kind, plural }) as CrdDetailInfo;

const object = (
  apiVersion: string,
  kind: string
): CustomResourceDetailInfo => ({
  name: "frontend",
  namespace: "storefront",
  uid: "own-uid",
  apiVersion,
  kind,
  spec: {},
  status: null,
  labels: {},
  annotations: {},
  createdAt: null,
  ownerReferences: [],
  finalizers: [],
  resourceVersion: null,
  generation: null,
  fields: {},
});

const open = (crdName: string, tab = "overview") =>
  renderWithRouter(
    <CustomResourceDetail
      crdName={crdName}
      namespace="storefront"
      name="frontend"
    />,
    { at: `/c/test/${crdName}/storefront/frontend?tab=${tab}` }
  );

beforeEach(() => {
  useClusterStore.setState({ currentContext: "test", isConnected: true });
  answers.events.mockClear();
  answers.replicaSets.mockClear();
  answers.connections.mockClear();
});

describe("the page of a custom resource named like a built-in", () => {
  /**
   * A CRD may call its kind Deployment. Fails if the page reads its events
   * as the built-in's, which asks for that Deployment's ReplicaSets and
   * their warnings.
   */
  it("reads its events as its own, not as the built-in's of that name", async () => {
    answers.crd = crd("apps.example.dev", "Deployment", "deployments");
    answers.resource = object("apps.example.dev/v1", "Deployment");
    await open("deployments.apps.example.dev");
    await waitFor(() =>
      expect(answers.events).toHaveBeenCalledWith(
        expect.objectContaining({
          involved_object_kind: "Deployment",
          involved_object_name: "frontend",
        })
      )
    );
    expect(answers.replicaSets).not.toHaveBeenCalled();
    expect(
      answers.events.mock.calls.map(([filter]) => filter.involved_object_kind)
    ).not.toContain("ReplicaSet");
  });

  /**
   * Knative makes a core Service named like its own. Fails if Share on the
   * Knative one reads the graph of that core Service into its report.
   */
  it("shares it without the graph of the built-in of that name", async () => {
    answers.crd = crd("serving.knative.dev", "Service", "services");
    answers.resource = object("serving.knative.dev/v1", "Service");
    await open("services.serving.knative.dev");
    await userEvent.click(await screen.findByRole("button", { name: "Share" }));
    // The report's own events read says the capture is under way.
    await waitFor(() =>
      expect(answers.events.mock.calls.length).toBeGreaterThan(1)
    );
    expect(answers.connections).not.toHaveBeenCalled();
  });

  /**
   * A Knative Configuration is owned by a Knative Service, and Knative makes
   * a core Service of that name. Fails if the owner opens the core one.
   */
  it("opens an owner named like a built-in by its group", async () => {
    answers.crds = [
      {
        group: "serving.knative.dev",
        crds: [
          {
            name: "services.serving.knative.dev",
            group: "serving.knative.dev",
            kind: "Service",
          },
        ],
      },
    ];
    answers.crd = crd("serving.knative.dev", "Configuration", "configurations");
    answers.resource = {
      ...object("serving.knative.dev/v1", "Configuration"),
      ownerReferences: [
        {
          apiVersion: "serving.knative.dev/v1",
          kind: "Service",
          name: "frontend",
          uid: "owner",
          controller: true,
        },
      ],
    };
    await open("configurations.serving.knative.dev", "metadata");
    expect(
      await screen.findByRole("link", { name: /Service frontend/ })
    ).toHaveAttribute(
      "href",
      "/c/test/services.serving.knative.dev/storefront/frontend"
    );
  });
});
