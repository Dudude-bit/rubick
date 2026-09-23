import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/commands", () => ({
  commands: {
    listCustomResources: vi.fn(),
    listPods: vi.fn(),
    getObjectMetadata: vi.fn(),
  },
}));

import { commands } from "@/lib/commands";
import { fetchAksPicture } from "./data";
import { AZURE_IDENTITY_CRD } from "./model";

/** What the command wrapper rejects with: the backend's code and words. */
const failure = (code: string, message: string) =>
  Object.assign(new Error(message), { code });

const notServed = () =>
  failure("NOT_FOUND", "customresourcedefinitions not found");
const forbidden = (what: string) =>
  failure("PERMISSION_DENIED", `${what} is forbidden`);

beforeEach(() => {
  vi.mocked(commands.listCustomResources).mockReset();
  vi.mocked(commands.listPods).mockReset();
  vi.mocked(commands.listPods).mockResolvedValue([]);
});

describe("what the AKS page reads", () => {
  /** The retired add-on not being served is the ordinary answer: none of it. */
  it("reads a kind the cluster does not serve as none, and says nothing", async () => {
    vi.mocked(commands.listCustomResources).mockRejectedValue(notServed());

    const picture = await fetchAksPicture();

    expect(picture.legacyInstalled).toBe(false);
    expect(picture.unread).toEqual([]);
  });

  /**
   * A refusal is not "not served". Every failure used to become an empty
   * list, and the page said the add-on was not installed on a cluster that
   * only refused this token.
   */
  it("keeps a refused kind as unread, and does not call the add-on absent", async () => {
    vi.mocked(commands.listCustomResources).mockImplementation(async (crd) => {
      if (crd === AZURE_IDENTITY_CRD) throw forbidden("azureidentities");
      throw notServed();
    });

    const picture = await fetchAksPicture();

    expect(picture.legacyInstalled).toBeNull();
    expect(picture.unread).toEqual([
      expect.objectContaining({ what: AZURE_IDENTITY_CRD }),
    ]);
  });

  /**
   * The pods that ask for an identity could not be listed: "no pod carries
   * the label" is then something the page does not know.
   */
  it("does not claim no pod asks for an identity when the pods were refused", async () => {
    vi.mocked(commands.listCustomResources).mockRejectedValue(notServed());
    vi.mocked(commands.listPods).mockRejectedValue(forbidden("pods"));

    const picture = await fetchAksPicture();

    expect(picture.podsKnown).toBe(false);
    expect(picture.unread).toEqual([expect.objectContaining({ what: "Pod" })]);
  });
});
