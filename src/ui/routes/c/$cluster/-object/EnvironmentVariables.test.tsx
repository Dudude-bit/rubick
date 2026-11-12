import { describe, expect, it, vi } from "vite-plus/test";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

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

describe("the eye on one Secret-backed variable", () => {
  const present = () =>
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
  const reveal = async () => {
    await screen.findByText("••••••••");
    await userEvent.click(screen.getByRole("button", { name: "Reveal" }));
  };

  /** The values were read only under the switch, so the row's own eye had
   *  nothing to show and said the key was not found. Fails if the eye does
   *  not ask for the value. */
  it("reads the value it is asked to show", async () => {
    present();
    vi.mocked(commands.getSecretData).mockResolvedValue({
      values: { DB_PASSWORD: "hunter2" },
      withheld: {},
      binary: {},
    });
    await renderWithRouter(dbPassword(), POD);
    expect(commands.getSecretData).not.toHaveBeenCalled();

    await reveal();

    expect(await screen.findByText("hunter2")).toBeInTheDocument();
    expect(screen.queryByText(/not found/)).toBeNull();
    expect(screen.getByRole("button", { name: "Copy" })).toBeInTheDocument();
  });

  /** A key the backend keeps back is in the Secret; "not found" with a Copy
   *  button beside it put that sentence on the clipboard as the password. */
  it("says a withheld key is withheld and offers nothing to copy", async () => {
    present();
    vi.mocked(commands.getSecretData).mockResolvedValue({
      values: {},
      withheld: { DB_PASSWORD: { says: "privateKey" } },
      binary: {},
    });
    await renderWithRouter(dbPassword(), POD);
    await reveal();

    expect(
      await screen.findByText("a private key, which the app never shows")
    ).toBeInTheDocument();
    expect(screen.queryByText(/not found/)).toBeNull();
    expect(screen.queryByRole("button", { name: "Copy" })).toBeNull();
  });

  /** A values read that was refused has not looked. */
  it("says a refused read was refused, never that the key is not found", async () => {
    present();
    vi.mocked(commands.getSecretData).mockRejectedValue({
      code: "PERMISSION_DENIED",
      message: "secrets is forbidden",
    });
    await renderWithRouter(dbPassword(), POD);
    await reveal();

    expect(
      await screen.findByText("not readable with this access")
    ).toBeInTheDocument();
    expect(screen.queryByText(/not found/)).toBeNull();
    expect(screen.queryByRole("button", { name: "Copy" })).toBeNull();
  });
});

describe("variables taken whole from a Secret or a ConfigMap", () => {
  const whole = (
    <EnvironmentVariables
      namespace="team-checkout"
      env={[]}
      envFrom={[
        {
          prefix: null,
          secretRef: "checkout-db",
          configMapRef: null,
          optional: null,
        },
        {
          prefix: "APP_",
          secretRef: null,
          configMapRef: "app",
          optional: null,
        },
      ]}
    />
  );

  /**
   * With the switch on, an envFrom Secret whose values read failed drew no
   * row at all, and a ConfigMap's said "(no data found)": a refusal and a
   * fault both read as a source holding nothing. Fails if such a row goes,
   * or says there is no data where nobody could look.
   */
  it("says a source that could not be read was refused or failed, never that it holds nothing", async () => {
    vi.mocked(commands.getSecret).mockResolvedValue({
      dataKeys: ["DB_PASSWORD"],
    } as never);
    vi.mocked(commands.getSecretData).mockRejectedValue({
      code: "PERMISSION_DENIED",
      message: "secrets is forbidden",
    });
    vi.mocked(commands.getConfigmapData).mockRejectedValue(
      new Error("connection reset by peer")
    );
    await renderWithRouter(whole, POD);
    await userEvent.click(await screen.findByRole("switch"));

    expect(
      await screen.findByText("not readable with this access")
    ).toBeInTheDocument();
    expect(
      await screen.findByText("connection reset by peer")
    ).toBeInTheDocument();
    expect(screen.queryByText("(no data found)")).toBeNull();
  });

  /** A source that answered and holds no key is the one that has no data. */
  it("says a source that answered with nothing has no data", async () => {
    const none = { values: {}, withheld: {}, binary: {} };
    vi.mocked(commands.getSecret).mockResolvedValue({ dataKeys: [] } as never);
    vi.mocked(commands.getSecretData).mockResolvedValue(none);
    vi.mocked(commands.getConfigmapData).mockResolvedValue(none);
    await renderWithRouter(whole, POD);
    await userEvent.click(await screen.findByRole("switch"));

    await waitFor(() =>
      expect(screen.getAllByText("(no data found)")).toHaveLength(2)
    );
  });
});
