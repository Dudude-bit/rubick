import type { ReactNode } from "react";

const styles = {
  primary:
    "bg-accent text-white hover:bg-blue-500 active:scale-[0.97] shadow-lg shadow-accent/25",
  ghost:
    "border border-neutral-700 text-neutral-200 hover:border-neutral-500 hover:text-white active:scale-[0.97]",
} as const;

export function ButtonLink({
  href,
  variant = "primary",
  children,
}: {
  href: string;
  variant?: keyof typeof styles;
  children: ReactNode;
}) {
  return (
    <a
      href={href}
      className={`inline-flex min-h-11 items-center justify-center gap-2 rounded-lg px-5 py-2.5 font-medium transition-[background-color,border-color,color,transform] duration-150 ${styles[variant]}`}
    >
      {children}
    </a>
  );
}
