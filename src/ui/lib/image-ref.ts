/**
 * The grammar of a container image reference: given something already known
 * to be an image — a container's `image` field, the inside of a quoted
 * reference — it says how to split it.
 *
 * Detection is deliberately somewhere else. `linkifyMessage` in
 * `message-refs` decides which spans of a sentence are images at all, and
 * keeping the two apart is what stops this grammar from being run over prose,
 * where it would happily claim `ratio:0.82` and `10.42.0.6:8080`.
 */

export interface ImageReference {
  /** Exactly what was parsed, for the clipboard. */
  reference: string;
  /** `null` for a bare `busybox`, where the daemon supplies the default. */
  registry: string | null;
  /** The part a reader recognises: `busybox`, `project/sub/app`. */
  repository: string;
  tag: string | null;
  digest: string | null;
}

/**
 * `algorithm:hex`, per the distribution spec. The hex floor of 32 is what
 * keeps a plain `sha256:abc` — the shape a truncated log line has — out.
 */
const DIGEST = /^[a-z][a-z0-9]*(?:[.+_-][a-z0-9]+)*:[0-9a-fA-F]{32,}$/;
/** A tag may carry upper case and underscores; a repository path may not. */
const TAG = /^\w[\w.-]{0,127}$/;
const PATH_COMPONENT = /^[a-z0-9]+(?:(?:\.|_|__|-+)[a-z0-9]+)*$/;
const DOMAIN =
  /^[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?)*(?::\d{1,5})?$/;

/** Nothing legal is anywhere near this long; a runaway string is not a ref. */
const MAX_LENGTH = 512;

export function parseImageRef(input: string): ImageReference | null {
  if (!input || input.length > MAX_LENGTH || /\s/.test(input)) return null;

  let rest = input;

  let digest: string | null = null;
  const at = rest.indexOf("@");
  if (at !== -1) {
    digest = rest.slice(at + 1);
    rest = rest.slice(0, at);
    if (!DIGEST.test(digest)) return null;
  }

  // The tag's colon is the last one, and only if no `/` follows it —
  // otherwise the colon belongs to a registry port, as in `localhost:5000/app`.
  let tag: string | null = null;
  const colon = rest.lastIndexOf(":");
  if (colon !== -1 && !rest.slice(colon + 1).includes("/")) {
    tag = rest.slice(colon + 1);
    rest = rest.slice(0, colon);
    if (!TAG.test(tag)) return null;
  }

  // A first path component is a registry only when it looks like a host:
  // a dot, a port, or the literal `localhost`. `project/app` has none of
  // those and is a two-part repository on the default registry.
  let registry: string | null = null;
  const slash = rest.indexOf("/");
  if (slash > 0) {
    const head = rest.slice(0, slash);
    if (head === "localhost" || head.includes(".") || head.includes(":")) {
      if (!DOMAIN.test(head)) return null;
      registry = head;
      rest = rest.slice(slash + 1);
    }
  }

  if (!rest) return null;
  const components = rest.split("/");
  if (!components.every((component) => PATH_COMPONENT.test(component))) {
    return null;
  }

  return { reference: input, registry, repository: rest, tag, digest };
}

/** Where a reference can be read on the web. */
export interface RegistryLink {
  url: string;
  /** Named before the reader leaves, so they know the site: "Docker Hub". */
  site: string;
  /** What that page is about — carries the tag only where the URL does. */
  name: string;
}

/**
 * A registry only gets a link when its web address falls out of the reference
 * mechanically. `registry.k8s.io` serves no page at all, `gcr.io` redirects to
 * a Cloud console behind a sign-in and a project the app cannot know, and a
 * private `registry.corp.internal` has no website to send anyone to. A link
 * that lands on a 404 or a login wall makes the reader doubt the app rather
 * than the link, so those registries get nothing.
 *
 * A digest is never addressable here — no site takes one in a URL — so it is
 * dropped, and `name` says what the URL really opens: the tag where the site
 * can address one, the repository otherwise.
 */
export function registryLink(ref: ImageReference | null): RegistryLink | null {
  if (!ref) return null;
  const { registry, repository, tag } = ref;
  const depth = repository.split("/").length;

  if (!registry || DOCKER_HUB_HOSTS.has(registry)) {
    return dockerHub(repository, tag);
  }

  if (registry === "quay.io") {
    // An org and a repository, exactly; Quay has no deeper path to open.
    if (depth !== 2) return null;
    const url = `https://quay.io/repository/${encodePath(repository)}`;
    return tag
      ? {
          url: `${url}?tab=tags&tag=${encodeURIComponent(tag)}`,
          site: QUAY,
          name: `${repository}:${tag}`,
        }
      : { url, site: QUAY, name: repository };
  }

  if (registry === "ghcr.io") {
    // ghcr.io answers a browser with a 303 to the package's GitHub page. That
    // redirect is the only form that works whether the owner is a person or an
    // organisation — `github.com/orgs/…` 404s for a user and `github.com/users/…`
    // drops an organisation on its profile — and it keeps the mapping GitHub's
    // to change rather than ours to guess.
    if (depth < 2) return null;
    return {
      url: `https://ghcr.io/${encodePath(repository)}`,
      site: GHCR,
      name: repository,
    };
  }

  if (registry === "public.ecr.aws") {
    if (depth < 2) return null;
    return {
      url: `https://gallery.ecr.aws/${encodePath(repository)}`,
      site: ECR,
      name: repository,
    };
  }

  if (registry === "mcr.microsoft.com") {
    return {
      url: `https://mcr.microsoft.com/en-us/artifact/mar/${encodePath(repository)}/about`,
      site: MCR,
      name: repository,
    };
  }

  return null;
}

const DOCKER_HUB = "Docker Hub";
const QUAY = "Quay";
const GHCR = "GitHub Container Registry";
const ECR = "ECR Public Gallery";
const MCR = "Microsoft Artifact Registry";

/** The names the daemon accepts for the registry a bare `busybox` comes from. */
const DOCKER_HUB_HOSTS = new Set([
  "docker.io",
  "index.docker.io",
  "registry-1.docker.io",
]);

/** The components are already validated, so this only guards against drift. */
const encodePath = (repository: string) =>
  repository.split("/").map(encodeURIComponent).join("/");

function dockerHub(
  repository: string,
  tag: string | null
): RegistryLink | null {
  const parts = repository.split("/");
  // `nginx` and `library/nginx` are the same official image, and Docker Hub
  // files those under `_/` rather than under a namespace.
  const official =
    parts.length === 1
      ? parts[0]
      : parts.length === 2 && parts[0] === "library"
        ? parts[1]
        : null;
  // A Hub repository is a namespace and a name. Anything deeper is a reference
  // the daemon would still resolve and a page Hub does not have.
  if (!official && parts.length !== 2) return null;

  const path = official
    ? `_/${encodeURIComponent(official)}`
    : `r/${encodePath(repository)}`;
  const name = official ?? repository;
  const url = `https://hub.docker.com/${path}`;
  return tag
    ? {
        url: `${url}/tags?name=${encodeURIComponent(tag)}`,
        site: DOCKER_HUB,
        name: `${name}:${tag}`,
      }
    : { url, site: DOCKER_HUB, name };
}
