/**
 * Kind hues for the five route kinds, shared by every surface that colours
 * a kind — the routes list's chips and the map's tags must be one palette,
 * or the same route reads as two different things at two zooms.
 *
 * The hues sit away from the state colors (ok 152, warn 44, err 358,
 * info 212) and stay desaturated: the verdict outranks the kind, and the
 * label text still carries the meaning without the hue.
 */

/** The list's chip: a quiet border and the same hue on the text. */
export const KIND_TONE: Record<string, string> = {
  HTTPRoute: "border-[hsl(190_45%_58%/0.35)] text-[hsl(190_45%_58%)]",
  GRPCRoute: "border-[hsl(265_50%_70%/0.35)] text-[hsl(265_50%_70%)]",
  TLSRoute: "border-[hsl(315_40%_64%/0.35)] text-[hsl(315_40%_64%)]",
  TCPRoute: "border-[hsl(25_55%_60%/0.35)] text-[hsl(25_55%_60%)]",
  UDPRoute: "border-[hsl(85_35%_55%/0.35)] text-[hsl(85_35%_55%)]",
};

/** The map's tag: hue on the text alone — a border would fight the node's. */
export const KIND_TEXT: Record<string, string> = {
  HTTPRoute: "text-[hsl(190_45%_58%)]",
  GRPCRoute: "text-[hsl(265_50%_70%)]",
  TLSRoute: "text-[hsl(315_40%_64%)]",
  TCPRoute: "text-[hsl(25_55%_60%)]",
  UDPRoute: "text-[hsl(85_35%_55%)]",
};
