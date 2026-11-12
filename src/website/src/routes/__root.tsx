import {
  createRootRoute,
  HeadContent,
  Outlet,
  Scripts,
} from "@tanstack/react-router";
import { NotFound } from "../components/not-found";
import { JSON_LD, OG_IMAGE, SITE } from "../lib/site";
import appCss from "../styles.css?url";

/**
 * Arm the scroll reveal, and disarm it if the bundle never turns up.
 *
 * `@media (scripting: enabled)` says JavaScript is allowed, not that it ran,
 * so a bundle that 404s or is stripped by a proxy would leave every
 * `[data-reveal]` at `opacity: 0` for good — the whole page below the hero.
 * Arming here rather than at hydration is what keeps the reveal from
 * flashing; `use-in-view` clears the timer as soon as it observes anything,
 * so the timeout only ever fires on a page whose bundle did not arrive.
 */
const ARM_REVEAL = `document.documentElement.setAttribute('data-reveal-armed','');
window.__disarmReveal=setTimeout(function(){document.documentElement.removeAttribute('data-reveal-armed')},5000)`;

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: SITE.title },
      { name: "description", content: SITE.description },
      { property: "og:site_name", content: SITE.name },
      { property: "og:title", content: SITE.title },
      { property: "og:description", content: SITE.description },
      { property: "og:type", content: "website" },
      { property: "og:url", content: SITE.url },
      { property: "og:locale", content: "en_US" },
      { property: "og:image", content: OG_IMAGE.url },
      { property: "og:image:width", content: OG_IMAGE.width },
      { property: "og:image:height", content: OG_IMAGE.height },
      { property: "og:image:alt", content: OG_IMAGE.alt },
      { name: "twitter:card", content: "summary_large_image" },
      { name: "twitter:title", content: SITE.title },
      { name: "twitter:description", content: SITE.description },
      { name: "twitter:image", content: OG_IMAGE.url },
      { name: "theme-color", content: "#0a0a0a" },
    ],
    links: [
      { rel: "stylesheet", href: appCss },
      { rel: "icon", type: "image/svg+xml", href: "/logo.svg" },
      { rel: "apple-touch-icon", href: "/apple-touch-icon.png" },
    ],
    scripts: [
      { type: "application/ld+json", children: JSON_LD },
      { children: ARM_REVEAL },
    ],
  }),
  component: RootComponent,
  notFoundComponent: NotFound,
});

function RootComponent() {
  return (
    <html
      lang="en"
      className="bg-neutral-950 font-display text-neutral-100 antialiased"
    >
      <head>
        <HeadContent />
      </head>
      <body>
        <Outlet />
        <Scripts />
      </body>
    </html>
  );
}
