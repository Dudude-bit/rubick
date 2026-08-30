import { createFileRoute } from "@tanstack/react-router";
import { Hero } from "../sections/hero";
import { Nav } from "../sections/nav";

export const Route = createFileRoute("/")({
  component: Landing,
});

function Landing() {
  return (
    <>
      <Nav />
      <main>
        <Hero />
      </main>
    </>
  );
}
