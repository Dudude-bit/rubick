import { createFileRoute } from "@tanstack/react-router";
import { CertificatesPage } from "../components/certificates-page";
import { articleLd, SITE } from "../lib/site";
import { CERTIFICATES, pageUrl } from "../lib/pages";

const { title, description } = CERTIFICATES;
const image = `${SITE.url}/og/certificates.png`;
const url = pageUrl(CERTIFICATES);

export const Route = createFileRoute("/certificates")({
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
          "The certificates card: what issued each certificate, when it expires, and what renews it",
      },
      { name: "twitter:title", content: title },
      { name: "twitter:description", content: description },
      { name: "twitter:image", content: image },
    ],
    links: [{ rel: "canonical", href: url }],
    scripts: [articleLd({ title, description, url, image })],
  }),
  component: CertificatesPage,
});
