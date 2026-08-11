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
