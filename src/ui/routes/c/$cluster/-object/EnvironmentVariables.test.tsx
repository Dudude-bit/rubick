import { describe, expect, it, vi } from "vite-plus/test";
import { screen, waitFor } from "@testing-library/react";

vi.mock("@/lib/commands", () => ({
  commands: {
    getConfigmapData: vi.fn(async () => ({
      values: { LOG_LEVEL: "debug" },
      withheld: {},
      binary: {},
    })),
    getConfigmap: vi.fn(async () => ({ dataKeys: ["LOG_LEVEL"] })),
    getSecret: vi.fn(),
    getSecretData: vi.fn(),
  },
}));

import { commands } from "@/lib/commands";
import { queryKeys } from "@/lib/query-keys";
import { renderWithRouter } from "@/test/render";
import { EnvironmentVariables } from "./EnvironmentVariables";

/**
 * The pod's environment and the ConfigMap's own page read the same values
 * with namespace and name in opposite orders, so an edit saved on the page
 * never reached a pod's env — and a ConfigMap `app` in `prod` shared an entry
 * with a ConfigMap `prod` in `app`. Fails if the env keys the values anywhere
 * but where the page invalidates them.
 */
describe("a pod's environment", () => {
  it("re-reads a ConfigMap once its page has changed a key", async () => {
    const { client } = await renderWithRouter(
      <EnvironmentVariables
        namespace="prod"
        envFrom={[]}
        env={[
          {
            name: "LOG_LEVEL",
            value: null,
            valueFrom: {
              sourceType: "configMapKeyRef",
              name: "app",
              key: "LOG_LEVEL",
              fieldPath: null,
              resource: null,
              optional: null,
            },
          },
        ]}
      />,
      {
        at: "/c/prod/pods/prod/api-0",
        route: "/c/$cluster/$resource/$namespace/$name",
      }
    );
    await waitFor(() =>
      expect(commands.getConfigmapData).toHaveBeenCalledTimes(1)
    );

    await client.invalidateQueries({
      queryKey: queryKeys.configMapData("prod", "app"),
    });
    expect(commands.getConfigmapData).toHaveBeenCalledTimes(2);
  });
});

const POD = {
  at: "/c/prod/pods/team-checkout/checkout-worker-0",
  route: "/c/$cluster/$resource/$namespace/$name",
};

function dbPassword(optional: boolean | null = null) {
  return (
    <EnvironmentVariables
      namespace="team-checkout"
      envFrom={[]}
      env={[
        {
          name: "DB_PASSWORD",
          value: null,
          valueFrom: {
            sourceType: "secretKeyRef",
            name: "checkout-db",
            key: "DB_PASSWORD",
            fieldPath: null,
            resource: null,
            optional,
          },
        },
      ]}
    />
  );
}

const textOf = (pattern: RegExp) => (_: string, node: Element | null) =>
  !!node?.textContent &&
  pattern.test(node.textContent) &&
  Array.from(node.children).every(
    (child) => !pattern.test(child.textContent ?? "")
  );

describe("a variable read from a Secret", () => {
  /** DB_PASSWORD drew nine masked dots like a real secret, and only the eye
   *  showed the key was not there. Fails if the missing key waits for a click. */
  it("says the key is missing, and which keys exist, before anything is revealed", async () => {
    vi.mocked(commands.getSecret).mockResolvedValue({
      name: "checkout-db",
      namespace: "team-checkout",
      uid: "u",
      type: "Opaque",
      dataKeys: ["password", "username"],
      labels: {},
      annotations: {},
      createdAt: null,
    });
    await renderWithRouter(dbPassword(), POD);

    const line = await screen.findByText(
      textOf(/^key DB_PASSWORD is not in Secret.*checkout-db$/)
    );
    expect(line.closest(".text-err")).not.toBeNull();
    expect(screen.getByText("password, username")).toBeInTheDocument();
    expect(screen.queryByText("••••••••")).toBeNull();
  });

  /** A refused read is not "missing" and not a value. */
  it("says it could not look when the Secret is refused, never dots or missing", async () => {
    vi.mocked(commands.getSecret).mockRejectedValue({
      code: "PERMISSION_DENIED",
      message: "secrets is forbidden",
    });
    await renderWithRouter(dbPassword(), POD);

    expect(
      await screen.findByText(textOf(/^no access to Secret.*checkout-db/))
    ).toBeInTheDocument();
    expect(screen.queryByText(/is not in|does not exist/)).toBeNull();
    expect(screen.queryByText("••••••••")).toBeNull();
  });

  /** optional: true still starts the pod, so it is a warning, and it says why. */
  it("calls a missing optional Secret a warning and says the pod still starts", async () => {
    vi.mocked(commands.getSecret).mockRejectedValue({
      code: "NOT_FOUND",
      message: 'secrets "checkout-db" not found',
    });
    await renderWithRouter(dbPassword(true), POD);

    const line = await screen.findByText(
      textOf(/^Secret.*checkout-db does not exist$/)
    );
    expect(line.closest(".text-warn")).not.toBeNull();
    expect(
      screen.getByText("optional, so the pod starts without it")
    ).toBeInTheDocument();
  });

  /** A key that is there keeps its mask: the change must not reveal values. */
  it("keeps a key that exists masked", async () => {
    vi.mocked(commands.getSecret).mockResolvedValue({
      name: "checkout-db",
      namespace: "team-checkout",
      uid: "u",
      type: "Opaque",
      dataKeys: ["DB_PASSWORD"],
      labels: {},
      annotations: {},
      createdAt: null,
    });
    await renderWithRouter(dbPassword(), POD);

    expect(await screen.findByText("••••••••")).toBeInTheDocument();
    expect(screen.queryByText(/is not in|does not exist/)).toBeNull();
  });
});
