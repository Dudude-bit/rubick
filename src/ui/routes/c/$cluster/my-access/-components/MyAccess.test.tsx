import { fireEvent, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type { OwnRules } from "@/generated/types";
import { useClusterStore } from "@/stores/clusterStore";
import { renderWithRouter } from "@/test/render";

const answers = vi.hoisted(() => ({
  asked: [] as string[],
  review: (namespace: string): Promise<OwnRules> =>
    Promise.resolve({
      namespace,
      rules: [],
      incomplete: false,
      evaluationError: null,
    }),
}));

vi.mock("@/lib/commands", () => ({
  commands: {
    reviewOwnRules: (namespace: string) => {
      answers.asked.push(namespace);
      return answers.review(namespace);
    },
  },
}));

const { MyAccess } = await import("./MyAccess");

const rule = (resources: string[], verbs: string[]) => ({
  apiGroups: [""],
  resources,
  resourceNames: [],
  nonResourceUrls: [],
  verbs,
});

const scoped = (namespaceScope: string[]) =>
  useClusterStore.setState({
    currentContext: "test",
    isConnected: true,
    namespaceScope,
  });

beforeEach(() => {
  answers.asked = [];
  answers.review = (namespace) =>
    Promise.resolve({
      namespace,
      rules: [rule(["pods"], ["get", "list"])],
      incomplete: false,
      evaluationError: null,
    });
  scoped(["team-checkout"]);
});

describe("what the signed-in user may do", () => {
  /** Marco's question without kubectl: his own rules in his namespace. */
  it("draws the cluster's rules for the namespace on screen", async () => {
    await renderWithRouter(<MyAccess />);
    expect(await screen.findByText("pods")).toBeInTheDocument();
    expect(screen.getByText("In team-checkout")).toBeInTheDocument();
    expect(answers.asked).toEqual(["team-checkout"]);
  });

  /**
   * Rights are per namespace: an answer for one picked at random would be
   * read as the answer for all. Fails if the page asks without a namespace.
   */
  it("asks for one namespace under All namespaces instead of answering for one", async () => {
    scoped([]);
    await renderWithRouter(<MyAccess />);
    expect(
      screen.getByText(/Rules are granted per namespace/)
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Choose a namespace" })
    ).toBeInTheDocument();
    expect(answers.asked).toEqual([]);
  });

  /** A webhook authorizer that cannot list rules: the list is a floor, and says so. */
  it("shows the incomplete flag and the evaluation error, and gives no total", async () => {
    answers.review = (namespace) =>
      Promise.resolve({
        namespace,
        rules: [rule(["pods"], ["get"])],
        incomplete: true,
        evaluationError: "webhook authorizer does not support rule listing",
      });
    await renderWithRouter(<MyAccess />);
    expect(
      await screen.findByText(/The cluster says this list is incomplete/)
    ).toBeVisible();
    expect(
      screen.getByText("webhook authorizer does not support rule listing")
    ).toBeVisible();
    expect(
      screen.getByText("In team-checkout").parentElement
    ).not.toHaveTextContent("1");
  });

  /** An error reported beside a complete list is still shown. */
  it("shows an evaluation error the cluster reported on a complete list", async () => {
    answers.review = (namespace) =>
      Promise.resolve({
        namespace,
        rules: [],
        incomplete: false,
        evaluationError: 'role.rbac.authorization.k8s.io "gone" not found',
      });
    await renderWithRouter(<MyAccess />);
    expect(
      await screen.findByText(/reported an error while working out this list/)
    ).toBeVisible();
    expect(screen.getByText(/"gone" not found/)).toBeVisible();
  });

  /** A review the cluster refused is not an empty list of rules. */
  it("says it could not ask, with the refusal, rather than listing nothing", async () => {
    answers.review = () =>
      Promise.reject({
        code: "PERMISSION_DENIED",
        message: "selfsubjectrulesreviews is forbidden",
      });
    await renderWithRouter(<MyAccess />);
    expect(
      await screen.findByText(
        "Could not ask the cluster what you may do in team-checkout."
      )
    ).toBeVisible();
    expect(screen.queryByText(/lists no rules/)).toBeNull();
  });

  it("answers for whichever of several picked namespaces is chosen", async () => {
    scoped(["team-checkout", "payments"]);
    await renderWithRouter(<MyAccess />);
    await screen.findByText("In team-checkout");
    fireEvent.click(screen.getByRole("tab", { name: "payments" }));
    expect(await screen.findByText("In payments")).toBeInTheDocument();
    expect(answers.asked).toContain("payments");
  });
});
