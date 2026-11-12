/**
 * Kind hues for the five route kinds, shared by every surface that colours
 * a kind — the routes list's chips and the map's tags must be one palette,
 * or the same route reads as two different things at two zooms.
 *
 * The hues sit away from the state colors (ok 152, warn 44, err 358,
 * info 212) and stay desaturated: the verdict outranks the kind, and the
 * label text still carries the meaning without the hue.
 *
 * Only the hue is fixed here. Saturation and lightness come from `--kind-s`
 * and `--kind-l`, the way every other kind-tinted surface in the app takes
 * them, because the themes need different ones — `--kind-l` moves 38% to 70%
 * between them. A lightness frozen at the dark canvas's value put UDPRoute
 * at roughly 2.2:1 on the light one, and the colour lint cannot catch that:
 * it matches named palette words, not `hsl(...)`.
 */

/** The list's chip: a quiet border and the same hue on the text. */
export const KIND_TONE: Record<string, string> = {
  HTTPRoute:
    "border-[hsl(190_var(--kind-s)_var(--kind-l)/0.35)] text-[hsl(190_var(--kind-s)_var(--kind-l))]",
  GRPCRoute:
    "border-[hsl(265_var(--kind-s)_var(--kind-l)/0.35)] text-[hsl(265_var(--kind-s)_var(--kind-l))]",
  TLSRoute:
    "border-[hsl(315_var(--kind-s)_var(--kind-l)/0.35)] text-[hsl(315_var(--kind-s)_var(--kind-l))]",
  TCPRoute:
    "border-[hsl(25_var(--kind-s)_var(--kind-l)/0.35)] text-[hsl(25_var(--kind-s)_var(--kind-l))]",
  UDPRoute:
    "border-[hsl(85_var(--kind-s)_var(--kind-l)/0.35)] text-[hsl(85_var(--kind-s)_var(--kind-l))]",
};

/** The map's tag: hue on the text alone — a border would fight the node's. */
export const KIND_TEXT: Record<string, string> = {
  HTTPRoute: "text-[hsl(190_var(--kind-s)_var(--kind-l))]",
  GRPCRoute: "text-[hsl(265_var(--kind-s)_var(--kind-l))]",
  TLSRoute: "text-[hsl(315_var(--kind-s)_var(--kind-l))]",
  TCPRoute: "text-[hsl(25_var(--kind-s)_var(--kind-l))]",
  UDPRoute: "text-[hsl(85_var(--kind-s)_var(--kind-l))]",
};
