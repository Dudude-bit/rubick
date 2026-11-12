import type { ReactNode } from "react";

const styles = {
  primary:
    "border border-transparent bg-accent text-white hover:bg-blue-500 active:scale-[0.96] shadow-lg shadow-accent/25",
  ghost:
    "border border-neutral-700 text-neutral-200 hover:border-neutral-500 hover:text-white active:scale-[0.96]",
} as const;

export function buttonClass(variant: keyof typeof styles = "primary") {
  return `inline-flex min-h-11 items-center justify-center gap-2 rounded-lg px-5 py-2.5 font-medium transition-[background-color,border-color,color,transform] duration-150 ${styles[variant]}`;
}

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
    <a href={href} className={buttonClass(variant)}>
      {children}
    </a>
  );
}
