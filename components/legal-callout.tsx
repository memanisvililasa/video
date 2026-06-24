import { Icon } from "@/components/icons";
import type { ReactNode } from "react";

export function LegalCallout({ children }: { children: ReactNode }) {
  return <aside className="my-8 flex gap-4 rounded-2xl border border-blue-100 bg-blue-50/70 p-5 text-sm leading-6 text-blue-950"><span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-white text-brand shadow-sm"><Icon name="shield" className="h-5 w-5" /></span><div>{children}</div></aside>;
}
