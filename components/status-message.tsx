import { Icon } from "@/components/icons";

export type StatusTone = "info" | "progress" | "success" | "warning" | "error";

const toneClasses: Record<StatusTone, string> = {
  info: "border-slate-200 bg-slate-50 text-slate-700",
  progress: "border-blue-100 bg-blue-50 text-blue-950",
  success: "border-emerald-100 bg-emerald-50 text-emerald-800",
  warning: "border-amber-100 bg-amber-50 text-amber-900",
  error: "border-red-100 bg-red-50 text-red-800"
};

export function StatusMessage({ tone = "info", title, text }: { tone?: StatusTone; title: string; text: string }) {
  return (
    <div
      role={tone === "error" ? "alert" : "status"}
      aria-live={tone === "error" ? "assertive" : "polite"}
      aria-atomic="true"
      className={`flex min-w-0 gap-3 rounded-xl border p-4 text-sm leading-6 ${toneClasses[tone]}`}
    >
      <span className="mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-white/80">
        <Icon name={tone === "success" ? "check" : tone === "error" ? "x" : tone === "progress" ? "sparkle" : "info"} className="h-4 w-4" />
      </span>
      <div className="min-w-0">
        <p className="break-words font-bold [overflow-wrap:anywhere]">{title}</p>
        <p className="mt-1 break-words opacity-85 [overflow-wrap:anywhere]">{text}</p>
      </div>
    </div>
  );
}
