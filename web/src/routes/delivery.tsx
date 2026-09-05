import { createFileRoute } from "@tanstack/react-router";
import { DeliveryPage } from "../components/delivery-page";
import { SITE } from "../lib/site";

const url = `${SITE.url}/delivery`;
const title = "Delivered by Argo CD or Flux, and whether your edit survives";
const description =
  "Argo CD Applications and Flux Kustomizations read live from Rubick's specimens: the controllers' status words, the revision each one applied, and what happens to a change made by hand.";

export const Route = createFileRoute("/delivery")({
  head: () => ({
    meta: [
      { title },
      { name: "description", content: description },
      { property: "og:title", content: title },
      { property: "og:description", content: description },
      { property: "og:url", content: url },
      { property: "og:image", content: `${SITE.url}/og/delivery.png` },
      {
        property: "og:image:alt",
        content:
          "The Argo CD and Flux delivery card: what applied each object, and whether an edit made by hand survives",
      },
      { name: "twitter:title", content: title },
      { name: "twitter:description", content: description },
      { name: "twitter:image", content: `${SITE.url}/og/delivery.png` },
    ],
    links: [{ rel: "canonical", href: url }],
  }),
  component: DeliveryPage,
});
