import type { Shot } from "../lib/site";

export function WindowFrame({
  img,
  alt,
  caption,
  eager = false,
}: {
  img: Shot;
  alt: string;
  caption?: string;
  eager?: boolean;
}) {
  return (
    <figure>
      <div className="overflow-hidden rounded-xl border border-neutral-800 bg-neutral-900 shadow-2xl shadow-black/50">
        <div className="flex gap-1.5 border-b border-neutral-800 px-4 py-3">
          <span className="size-3 rounded-full bg-neutral-700" />
          <span className="size-3 rounded-full bg-neutral-700" />
          <span className="size-3 rounded-full bg-neutral-700" />
        </div>
        <img
          src={img.src}
          width={img.width}
          height={img.height}
          alt={alt}
          loading={eager ? "eager" : "lazy"}
          className="block h-auto w-full outline-1 -outline-offset-1 outline-white/10"
        />
      </div>
      {caption ? (
        <figcaption className="mt-3 text-center font-mono text-sm text-neutral-500">
          {caption}
        </figcaption>
      ) : null}
    </figure>
  );
}
