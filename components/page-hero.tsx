import { Icon } from "@/components/icons";

export function PageHero({ eyebrow, title, description }: { eyebrow: string; title: string; description: string }) {
  return <section className="relative overflow-hidden bg-[#F7F9FF] py-16 sm:py-20"><div className="absolute left-1/2 top-0 h-80 w-[38rem] -translate-x-1/2 rounded-full bg-[#E3EAFF] blur-3xl" /><div className="relative mx-auto max-w-3xl px-5 text-center sm:px-8"><span className="inline-flex items-center gap-2 rounded-full border border-blue-100 bg-white px-3 py-1.5 text-xs font-bold uppercase tracking-[.12em] text-brand"><Icon name="sparkle" className="h-3.5 w-3.5" />{eyebrow}</span><h1 className="mt-5 text-4xl font-extrabold tracking-[-.055em] text-ink sm:text-5xl">{title}</h1><p className="mx-auto mt-5 max-w-2xl text-base leading-7 text-slate-600 sm:text-lg">{description}</p></div></section>;
}
