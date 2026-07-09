import { Icon } from "@/components/icons";

type StatusTone = "neutral" | "loading" | "success" | "error" | "warning";

const toneClasses: Record<StatusTone, string> = {
  neutral: "border-slate-100 bg-white text-slate-600",
  loading: "border-blue-100 bg-blue-50 text-blue-950",
  success: "border-emerald-100 bg-emerald-50 text-emerald-800",
  error: "border-red-100 bg-red-50 text-red-700",
  warning: "border-amber-100 bg-amber-50 text-amber-800"
};

export function StatusMessage({ tone = "neutral", title, text }: { tone?: StatusTone; title: string; text: string }) {
  return (
    <div className={`flex gap-3 rounded-xl border p-4 text-sm leading-6 ${toneClasses[tone]}`}>
      <span className="mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-white/80">
        <Icon name={tone === "success" ? "check" : tone === "error" ? "x" : tone === "loading" ? "sparkle" : "info"} className="h-4 w-4" />
      </span>
      <div>
        <p className="font-bold">{title}</p>
        <p className="mt-1 opacity-85">{text}</p>
      </div>
    </div>
  );
}
