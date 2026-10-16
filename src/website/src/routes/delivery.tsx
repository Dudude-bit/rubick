import { createFileRoute } from "@tanstack/react-router";
import { DeliveryPage } from "../components/delivery-page";
import { articleLd, SITE } from "../lib/site";
import { DELIVERY, pageUrl } from "../lib/pages";

const { title, description } = DELIVERY;
const image = `${SITE.url}/og/delivery.png`;
const url = pageUrl(DELIVERY);

export const Route = createFileRoute("/delivery")({
  head: () => ({
    meta: [
      { title },
      { name: "description", content: description },
      { property: "og:title", content: title },
      { property: "og:description", content: description },
      { property: "og:url", content: url },
      { property: "og:image", content: image },
      {
        property: "og:image:alt",
        content:
          "The Argo CD and Flux delivery card: what applied each object, and whether an edit made by hand survives",
      },
      { name: "twitter:title", content: title },
      { name: "twitter:description", content: description },
      { name: "twitter:image", content: image },
    ],
    links: [{ rel: "canonical", href: url }],
    scripts: [articleLd({ title, description, url, image })],
  }),
  component: DeliveryPage,
});
