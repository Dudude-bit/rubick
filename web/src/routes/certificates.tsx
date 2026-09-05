import { createFileRoute } from "@tanstack/react-router";
import { CertificatesPage } from "../components/certificates-page";
import { SITE } from "../lib/site";

const url = `${SITE.url}/certificates`;
const title = "Valid. For somebody else.";
const description =
  "cert-manager chains read live from Rubick's specimens: issuer, renewal dates, the Challenge that holds the sentence worth reading, and the host a valid certificate does not cover.";

export const Route = createFileRoute("/certificates")({
  head: () => ({
    meta: [
      { title },
      { name: "description", content: description },
      { property: "og:title", content: title },
      { property: "og:description", content: description },
      { property: "og:url", content: url },
      { property: "og:image", content: `${SITE.url}/og/certificates.png` },
      { name: "twitter:title", content: title },
      { name: "twitter:description", content: description },
      { name: "twitter:image", content: `${SITE.url}/og/certificates.png` },
    ],
    links: [{ rel: "canonical", href: url }],
  }),
  component: CertificatesPage,
});
