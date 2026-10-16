import { createFileRoute } from "@tanstack/react-router";
import { ComparePage } from "../../components/compare-page";
import { compareHead, COMPETITORS } from "../../lib/compare";

const c = COMPETITORS.find((x) => x.slug === "lens")!;

export const Route = createFileRoute("/vs/lens")({
  head: () => compareHead(c),
  component: Page,
});

function Page() {
  return <ComparePage c={c} />;
}
