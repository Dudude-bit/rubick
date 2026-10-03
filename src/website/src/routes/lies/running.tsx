import { createFileRoute } from "@tanstack/react-router";
import { LiePage } from "../../components/lie-page";
import { lieHead, LIES } from "../../lib/lies";

const lie = LIES.find((l) => l.slug === "running")!;

export const Route = createFileRoute("/lies/running")({
  head: () => lieHead(lie),
  component: Page,
});

function Page() {
  return <LiePage lie={lie} />;
}
