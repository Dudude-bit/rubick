import { createFileRoute } from "@tanstack/react-router";
import { Hero } from "../sections/hero";
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
      </main>
    </>
  );
}
