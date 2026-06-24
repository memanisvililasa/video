import type { MetadataRoute } from "next";

const baseUrl = "https://videosave.example";

export default function sitemap(): MetadataRoute.Sitemap {
  return ["", "/how-it-works", "/rules", "/dmca", "/privacy", "/contacts"].map((path) => ({
    url: `${baseUrl}${path || "/"}`,
    lastModified: new Date(),
    changeFrequency: "monthly",
    priority: path === "" ? 1 : 0.7
  }));
}
