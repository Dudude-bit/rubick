import { SITE } from "./site";

export type Page = {
  path: string;
  title: string;
  description: string;
};

export const DELIVERY: Page = {
  path: "/delivery",
  title: "Delivered by Argo CD or Flux, and whether your edit survives",
  description:
    "Argo CD Applications and Flux Kustomizations read live from Rubick's specimens: the controllers' status words, the revision each one applied, and what happens to a change made by hand.",
};

export const CERTIFICATES: Page = {
  path: "/certificates",
  title: "Valid. For somebody else.",
  description:
    "cert-manager chains read live from Rubick's specimens: issuer, renewal dates, the Challenge that holds the sentence worth reading, and the host a valid certificate does not cover.",
};

export const pageUrl = (page: Pick<Page, "path">) => `${SITE.url}${page.path}`;
