/**
 * Where a vendor's own screen lives.
 *
 * Its own module rather than a function in `index.ts` because a vendor folder
 * needs it too — cert-manager's Settings row links to Traefik's page as
 * readily as to its own — and importing the tree's door from inside the tree
 * is a cycle. The id is the URL segment, so there is no second name to keep
 * in step with `Vendor.id`.
 */
export function integrationPagePath(vendorId: string): string {
  return `/integrations/${vendorId}`;
}

/**
 * Where an extension that owns no screen is answered for instead.
 *
 * Not every extension earns a page — a controller that reads annotations has
 * nothing to list, and `registry.ts` refuses Prometheus one on purpose. What
 * they all have is a row in Settings → Integrations saying what they give,
 * whether they are here, and what they are doing, so that is where the
 * sidebar sends the reader rather than nowhere at all.
 */
export function integrationSettingsPath(vendorId: string): string {
  return `/integrations?vendor=${encodeURIComponent(vendorId)}`;
}
