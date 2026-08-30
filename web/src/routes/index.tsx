import { createFileRoute } from "@tanstack/react-router";
import { Features } from "../sections/features";
import { Hero } from "../sections/hero";
import { Integrations } from "../sections/integrations";
import { Lies } from "../sections/lies";
import { Nav } from "../sections/nav";
import { Warns } from "../sections/warns";

export const Route = createFileRoute("/")({
  component: Landing,
});

function Landing() {
  return (
    <>
      <Nav />
      <main>
        <Hero />
        <Lies />
        <Warns />
        <Features />
        <Integrations />
      </main>
    </>
  );
}
