/**
 * A page about one object is that object's alone. The router keeps a route's
 * component mounted while only its params change, so a draft, an open dialog
 * or a revealed value went on to the next object of the kind, and saved
 * there it wrote one object's text into the other. Keyed by the object its
 * address names, as the peek is, the page starts over instead.
 */
export const pagePerObject = {
  defaultRemountDeps: ({ params }: { params: object }) =>
    "name" in params ? params : undefined,
};
