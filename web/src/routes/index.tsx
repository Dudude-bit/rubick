import { createFileRoute } from "@tanstack/react-router";
import { SITE } from "../lib/site";
import { AntiFeatures } from "../sections/anti-features";
import { Features } from "../sections/features";
import { Footer } from "../sections/footer";
import { Hero } from "../sections/hero";
import { Install } from "../sections/install";
import { Integrations } from "../sections/integrations";
import { Lies } from "../sections/lies";
import { Nav } from "../sections/nav";
import { OpenSource } from "../sections/open-source";
import { Testimonials } from "../sections/testimonials";
import { Warns } from "../sections/warns";

export const Route = createFileRoute("/")({
  head: () => ({ links: [{ rel: "canonical", href: SITE.url }] }),
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
        <Testimonials />
        <AntiFeatures />
        <OpenSource />
        <Install />
      </main>
      <Footer />
    </>
  );
}
