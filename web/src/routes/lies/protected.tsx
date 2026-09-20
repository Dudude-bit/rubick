import { createFileRoute } from "@tanstack/react-router";
import { LiePage } from "../../components/lie-page";
import { lieHead, LIES } from "../../lib/lies";

const lie = LIES.find((l) => l.slug === "protected")!;

export const Route = createFileRoute("/lies/protected")({
  head: () => lieHead(lie),
  component: Page,
});

function Page() {
  return <LiePage lie={lie} />;
}
