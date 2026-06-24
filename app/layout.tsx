import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";
import { Footer } from "@/components/footer";
import { Header } from "@/components/header";

export const metadata: Metadata = {
  metadataBase: new URL("https://videosave.example"),
  title: {
    default: "VideoSave — легальное сохранение видео",
    template: "%s | VideoSave"
  },
  description: "Проверяйте доступные легальные способы сохранить видео, на которое у вас есть права.",
  openGraph: {
    type: "website",
    locale: "ru_RU",
    siteName: "VideoSave",
    title: "VideoSave — легальное сохранение видео",
    description: "Проверяйте доступные легальные способы сохранить видео, на которое у вас есть права."
  },
  robots: { index: true, follow: true }
};

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return <html lang="ru"><body><div className="min-h-screen bg-white"><Header /><main>{children}</main><Footer /></div></body></html>;
}
