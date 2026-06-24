import Link from "next/link";

export function Logo() {
  return (
    <Link href="/" className="group inline-flex items-center gap-2.5" aria-label="VideoSave — на главную">
      <span className="grid h-9 w-9 place-items-center rounded-xl bg-brand text-white shadow-[0_8px_16px_rgba(53,99,246,.26)] transition-transform group-hover:-rotate-6">
        <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 3v11"/><path d="m8 10 4 4 4-4"/><path d="M5 20h14"/></svg>
      </span>
      <span className="text-xl font-extrabold tracking-[-0.04em] text-ink">Video<span className="text-brand">Save</span></span>
    </Link>
  );
}
