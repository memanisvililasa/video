import type { ReactNode, SVGProps } from "react";

type IconName = "arrow" | "check" | "shield" | "bolt" | "lock" | "link" | "play" | "download" | "info" | "file" | "chevron" | "menu" | "x" | "sparkle";

export function Icon({ name, className = "", ...props }: { name: IconName } & SVGProps<SVGSVGElement>) {
  const common = { fill: "none", stroke: "currentColor", strokeWidth: 1.8, strokeLinecap: "round" as const, strokeLinejoin: "round" as const };
  const paths: Record<IconName, ReactNode> = {
    arrow: <><path {...common} d="M5 12h14M13 6l6 6-6 6" /></>,
    check: <path {...common} d="m5 12 4.2 4L19 6.5" />,
    shield: <><path {...common} d="M12 3 4.8 6v5.2c0 4.4 3 8.5 7.2 9.8 4.2-1.3 7.2-5.4 7.2-9.8V6L12 3Z" /><path {...common} d="m8.5 12 2.2 2.1 4.8-4.7" /></>,
    bolt: <path {...common} d="m13.2 2-8 11h6l-.4 9 8-12h-6L13.2 2Z" />,
    lock: <><rect {...common} x="5" y="10" width="14" height="11" rx="2" /><path {...common} d="M8 10V7a4 4 0 0 1 8 0v3" /></>,
    link: <><path {...common} d="M10 13.8a4.2 4.2 0 0 0 6 .1l2-2a4.2 4.2 0 0 0-6-6l-1.2 1.2" /><path {...common} d="M14 10.2a4.2 4.2 0 0 0-6-.1l-2 2a4.2 4.2 0 0 0 6 6l1.2-1.2" /></>,
    play: <path {...common} d="m9 7 8 5-8 5V7Z" />,
    download: <><path {...common} d="M12 3v12M7 10l5 5 5-5M5 21h14" /></>,
    info: <><circle {...common} cx="12" cy="12" r="9" /><path {...common} d="M12 11v5M12 8h.01" /></>,
    file: <><path {...common} d="M7 3h7l4 4v14H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Z" /><path {...common} d="M14 3v5h5M9 13h6M9 17h4" /></>,
    chevron: <path {...common} d="m9 18 6-6-6-6" />,
    menu: <><path {...common} d="M4 7h16M4 12h16M4 17h16" /></>,
    x: <path {...common} d="m6 6 12 12M18 6 6 18" />,
    sparkle: <><path {...common} d="m12 3 1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8L12 3Z" /><path {...common} d="m19 16 .8 2.2L22 19l-2.2.8L19 22l-.8-2.2L16 19l2.2-.8L19 16Z" /></>
  };

  return <svg viewBox="0 0 24 24" aria-hidden="true" className={className} {...props}>{paths[name]}</svg>;
}
