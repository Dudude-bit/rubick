import type { ReactNode } from "react";

export function Section({
  id,
  eyebrow,
  className = "",
  children,
}: {
  id?: string;
  eyebrow?: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <section
      id={id}
      className={`mx-auto w-full max-w-6xl scroll-mt-20 px-6 py-24 md:py-32 ${className}`}
    >
      {eyebrow ? (
        <p className="text-accent mb-6 font-mono text-sm tracking-widest uppercase">
          {eyebrow}
        </p>
      ) : null}
      {children}
    </section>
  );
}
