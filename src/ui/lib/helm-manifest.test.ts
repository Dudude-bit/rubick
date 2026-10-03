import { describe, expect, it } from "vitest";

import { installedObjects } from "./helm-manifest";

/** What `helm get manifest` prints for a chart with two templates. */
const MANIFEST = `---
# Source: demo/templates/serviceaccount.yaml
apiVersion: v1
kind: ServiceAccount
metadata:
  name: demo
  labels:
    app: demo
---
# Source: demo/templates/service.yaml
apiVersion: v1
kind: Service
metadata:
  name: demo
spec:
  ports:
    - port: 80
---
# Source: demo/templates/deployment.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: demo
  namespace: elsewhere
spec:
  replicas: 1
`;

describe("installedObjects", () => {
  it("names every object the release declares, kind and name apart", () => {
    /** Flattening these into one display string is what would put the
     *  release's own contents out of reach — the only record of what a
     *  release installed is this manifest. */
    expect(installedObjects(MANIFEST, "apps")).toEqual([
      { kind: "ServiceAccount", name: "demo", namespace: "apps" },
      { kind: "Service", name: "demo", namespace: "apps" },
      { kind: "Deployment", name: "demo", namespace: "elsewhere" },
    ]);
  });

  it("falls back to the release's namespace only where the document states none", () => {
    /** A chart that pins `metadata.namespace` installs there, and inheriting
     *  the release's would send the reader to a page that does not exist. */
    const objects = installedObjects(MANIFEST, "apps");
    expect(objects.at(-1)?.namespace).toBe("elsewhere");
  });

  it("skips a document that names no object", () => {
    /** Helm emits leading `---` separators and templates that render to
     *  nothing but comments; both parse to null or to a document with no
     *  kind, and neither is something to offer as a link. */
    expect(
      installedObjects(
        "---\n# Source: demo/templates/empty.yaml\n---\n",
        "apps"
      )
    ).toEqual([]);
  });

  it("reads a chart that renders the same key twice", () => {
    /** Real charts do this — traefik's own manifest has a duplicated label —
     *  and js-yaml's default schema rejects the whole string for it, which
     *  lost every object in the release over one repeated line. */
    expect(
      installedObjects(
        `apiVersion: v1
kind: Service
metadata:
  name: dupe
  labels:
    app: a
    app: b
`,
        "apps"
      )
    ).toEqual([{ kind: "Service", name: "dupe", namespace: "apps" }]);
  });

  it("gives nothing rather than throwing on a manifest it cannot parse", () => {
    /** The manifest is a stored string the app did not write. A parse error
     *  must cost the Resources tab its rows, not the whole page. */
    expect(installedObjects("kind: [unclosed", "apps")).toEqual([]);
  });
});
