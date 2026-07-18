import "server-only";
import { AppError } from "@/lib/errors";
import { createManifestRunner, type ManifestBodyFetcher } from "@/lib/extractors/manifest-runner";
import type { ExtractorContext } from "@/lib/extractors/types";
import type { RedditMediaLocator } from "@/lib/extractors/reddit-metadata";
import { API_ERROR_CODES } from "@/lib/types";

const REDDIT_MEDIA_HOST = "v.redd.it";
const MAX_MANIFEST_BYTES = 256 * 1024;
const MAX_XML_DEPTH = 16;
const MAX_XML_NODES = 512;
const MAX_REPRESENTATIONS = 64;
const MAX_ATTRIBUTE_LENGTH = 8_192;
const MAX_BITRATE = 50_000_000;
const MAX_DURATION_SECONDS = 7 * 24 * 60 * 60;
const ALLOWED_ELEMENTS = new Set([
  "MPD",
  "Period",
  "AdaptationSet",
  "Representation",
  "BaseURL",
  "SegmentBase",
  "Initialization",
  "Role"
]);

type XmlNode = {
  name: string;
  attributes: Readonly<Record<string, string>>;
  children: XmlNode[];
  text: string;
};

export type RedditManifestRepresentation = Readonly<{
  identity: string;
  url: URL;
  kind: "progressive" | "video" | "audio";
  container: "mp4";
  videoCodec?: string;
  audioCodec?: string;
  width?: number;
  height?: number;
  fps?: number;
  bitrate: number;
  durationSeconds: number;
  filesizeEstimateBytes: number;
}>;

export type RedditManifest = Readonly<{
  mediaId: string;
  durationSeconds: number;
  representations: readonly RedditManifestRepresentation[];
}>;

export type RedditManifestBodyFetcher = ManifestBodyFetcher;

export type RedditManifestProvider = Readonly<{
  fetch(locator: RedditMediaLocator, context?: ExtractorContext): Promise<RedditManifest>;
}>;

export type CreateRedditManifestProviderOptions = Readonly<{
  fetchBody?: RedditManifestBodyFetcher;
}>;

function extractorFailed(): AppError {
  return new AppError(API_ERROR_CODES.EXTRACTOR_FAILED);
}

function normalizedHostname(hostname: string): string {
  return hostname.toLowerCase().replace(/\.$/, "");
}

export function isRedditMediaHostname(hostname: string): boolean {
  return normalizedHostname(hostname) === REDDIT_MEDIA_HOST;
}

export function isRedditMediaUrl(url: URL, mediaId: string): boolean {
  return url.protocol === "https:" &&
    isRedditMediaHostname(url.hostname) &&
    !url.username &&
    !url.password &&
    !url.port &&
    !url.hash &&
    !/[%\\\u0000-\u001f\u007f]/.test(url.pathname) &&
    url.pathname.startsWith(`/${mediaId}/`) &&
    !url.pathname.split("/").includes("..");
}

function decodeXml(value: string): string {
  if (/&(?!(?:amp|lt|gt|quot|apos);)/.test(value)) throw extractorFailed();
  return value
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'");
}

function parseAttributes(value: string): Readonly<Record<string, string>> {
  const attributes: Record<string, string> = {};
  let remainder = value;
  while (remainder.trim()) {
    const match = /^\s+([A-Za-z_][A-Za-z0-9_.:-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/.exec(remainder);
    if (!match) throw extractorFailed();
    const key = match[1];
    const raw = match[2] ?? match[3] ?? "";
    if (Object.prototype.hasOwnProperty.call(attributes, key) || raw.length > MAX_ATTRIBUTE_LENGTH) {
      throw extractorFailed();
    }
    attributes[key] = decodeXml(raw);
    remainder = remainder.slice(match[0].length);
  }
  return Object.freeze(attributes);
}

function parseXml(rawInput: string): XmlNode {
  if (
    !rawInput ||
    /[\u0000\uFFFD]/.test(rawInput) ||
    /<!/i.test(rawInput) ||
    /<\?(?!xml\s)/i.test(rawInput) ||
    /\]\]>/i.test(rawInput)
  ) throw extractorFailed();
  const raw = rawInput.replace(/^\uFEFF?\s*<\?xml\s+[^?]*\?>\s*/i, "");
  const tokens = raw.match(/<[^>]+>|[^<]+/g);
  if (!tokens || tokens.join("") !== raw) throw extractorFailed();

  const roots: XmlNode[] = [];
  const stack: XmlNode[] = [];
  let nodes = 0;
  for (const token of tokens) {
    if (!token.startsWith("<")) {
      if (stack.length === 0) {
        if (token.trim()) throw extractorFailed();
      } else {
        stack[stack.length - 1].text += token;
      }
      continue;
    }
    if (/^<\//.test(token)) {
      const match = /^<\/([A-Za-z][A-Za-z0-9_.-]*)\s*>$/.exec(token);
      const node = stack.pop();
      if (!match || !node || node.name !== match[1]) throw extractorFailed();
      continue;
    }
    const selfClosing = /\/\s*>$/.test(token);
    const match = /^<([A-Za-z][A-Za-z0-9_.-]*)([\s\S]*?)(?:\/\s*>|>)$/.exec(token);
    if (!match || !ALLOWED_ELEMENTS.has(match[1])) throw extractorFailed();
    nodes += 1;
    if (nodes > MAX_XML_NODES || stack.length + 1 > MAX_XML_DEPTH) throw extractorFailed();
    const node: XmlNode = {
      name: match[1],
      attributes: parseAttributes(match[2]),
      children: [],
      text: ""
    };
    const parent = stack[stack.length - 1];
    if (parent) parent.children.push(node);
    else roots.push(node);
    if (!selfClosing) stack.push(node);
  }
  if (stack.length !== 0 || roots.length !== 1 || roots[0].name !== "MPD") throw extractorFailed();
  const allowedChildren: Readonly<Record<string, ReadonlySet<string>>> = Object.freeze({
    MPD: new Set(["BaseURL", "Period"]),
    Period: new Set(["BaseURL", "AdaptationSet"]),
    AdaptationSet: new Set(["BaseURL", "Representation", "Role"]),
    Representation: new Set(["BaseURL", "SegmentBase"]),
    SegmentBase: new Set(["Initialization"]),
    Initialization: new Set<string>(),
    BaseURL: new Set<string>(),
    Role: new Set<string>()
  });
  const validate = (node: XmlNode): void => {
    if (node.name !== "BaseURL" && node.text.trim()) throw extractorFailed();
    const allowed = allowedChildren[node.name];
    if (!allowed || node.children.some((candidate) => !allowed.has(candidate.name))) throw extractorFailed();
    for (const candidate of node.children) validate(candidate);
  };
  validate(roots[0]);
  return roots[0];
}

function positiveInteger(value: string | undefined, maximum: number): number | undefined {
  if (!value || !/^\d+$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 && parsed <= maximum ? parsed : undefined;
}

function positiveNumber(value: string | undefined, maximum: number): number | undefined {
  if (!value || !/^\d+(?:\.\d+)?$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 && parsed <= maximum ? parsed : undefined;
}

function frameRate(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parts = value.split("/");
  if (parts.length > 2) return undefined;
  const numerator = positiveNumber(parts[0], 1_000_000);
  const denominator = parts.length === 2 ? positiveNumber(parts[1], 1_000_000) : 1;
  if (!numerator || !denominator) return undefined;
  const result = numerator / denominator;
  return Number.isFinite(result) && result > 0 && result <= 240 ? result : undefined;
}

function duration(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const match = /^PT(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?$/.exec(value);
  if (!match || (!match[1] && !match[2] && !match[3])) return undefined;
  const seconds = Number(match[1] ?? 0) * 3600 + Number(match[2] ?? 0) * 60 + Number(match[3] ?? 0);
  return Number.isFinite(seconds) && seconds > 0 && seconds <= MAX_DURATION_SECONDS ? seconds : undefined;
}

function child(node: XmlNode, name: string): XmlNode | undefined {
  const matches = node.children.filter((candidate) => candidate.name === name);
  if (matches.length > 1) throw extractorFailed();
  return matches[0];
}

function resolveBase(parent: URL, node: XmlNode, mediaId: string): URL {
  const base = child(node, "BaseURL");
  if (!base) return parent;
  if (base.children.length !== 0) throw extractorFailed();
  const value = decodeXml(base.text.trim());
  if (!value || value.length > MAX_ATTRIBUTE_LENGTH) throw extractorFailed();
  let resolved: URL;
  try {
    resolved = new URL(value, parent);
  } catch {
    throw extractorFailed();
  }
  if (!isRedditMediaUrl(resolved, mediaId)) throw extractorFailed();
  return resolved;
}

function codecParts(value: string | undefined): readonly string[] {
  return Object.freeze((value ?? "").split(",").map((part) => part.trim()).filter(Boolean));
}

function videoCodec(parts: readonly string[]): string | undefined {
  const value = parts.find((part) => /^(?:avc1|h264)(?:[._-]|$)/i.test(part));
  return value ? "h264" : undefined;
}

function audioCodec(parts: readonly string[]): string | undefined {
  const value = parts.find((part) => /^(?:mp4a|aac)(?:[._-]|$)/i.test(part));
  return value ? "aac" : undefined;
}

function representation(
  node: XmlNode,
  inherited: Readonly<Record<string, string>>,
  base: URL,
  mediaId: string,
  durationSeconds: number
): RedditManifestRepresentation {
  const attributes = { ...inherited, ...node.attributes };
  const identity = attributes.id;
  if (!identity || !/^[A-Za-z0-9._-]{1,128}$/.test(identity)) throw extractorFailed();
  const mimeType = attributes.mimeType?.toLowerCase();
  if (mimeType !== "video/mp4" && mimeType !== "audio/mp4" && mimeType !== "application/mp4") {
    throw extractorFailed();
  }
  const parts = codecParts(attributes.codecs);
  const video = videoCodec(parts);
  const audio = audioCodec(parts);
  const declaredType = attributes.contentType?.toLowerCase();
  const hasVideo = Boolean(video) || declaredType === "video";
  const hasAudio = Boolean(audio) || declaredType === "audio";
  if ((hasVideo && !video) || (hasAudio && !audio) || (!hasVideo && !hasAudio)) throw extractorFailed();
  const kind = hasVideo && hasAudio ? "progressive" : hasVideo ? "video" : "audio";
  const bitrate = positiveInteger(attributes.bandwidth, MAX_BITRATE);
  if (!bitrate) throw extractorFailed();
  const width = hasVideo ? positiveInteger(attributes.width, 16_384) : undefined;
  const height = hasVideo ? positiveInteger(attributes.height, 16_384) : undefined;
  if (hasVideo && (!width || !height)) throw extractorFailed();
  const fps = hasVideo ? frameRate(attributes.frameRate) : undefined;
  if (hasVideo && attributes.frameRate !== undefined && fps === undefined) throw extractorFailed();
  const url = resolveBase(base, node, mediaId);
  if (url === base || !isRedditMediaUrl(url, mediaId)) throw extractorFailed();
  const filesizeEstimateBytes = Math.ceil(bitrate * durationSeconds / 8);
  if (!Number.isSafeInteger(filesizeEstimateBytes) || filesizeEstimateBytes <= 0) throw extractorFailed();
  return Object.freeze({
    identity,
    url,
    kind,
    container: "mp4",
    ...(video ? { videoCodec: video } : {}),
    ...(audio ? { audioCodec: audio } : {}),
    ...(width ? { width } : {}),
    ...(height ? { height } : {}),
    ...(fps ? { fps } : {}),
    bitrate,
    durationSeconds,
    filesizeEstimateBytes
  });
}

export function parseRedditDashManifest(
  input: Buffer | string,
  manifestUrl: URL,
  mediaId: string
): RedditManifest {
  const raw = Buffer.isBuffer(input) ? input.toString("utf8") : input;
  if (Buffer.byteLength(raw) === 0 || Buffer.byteLength(raw) > MAX_MANIFEST_BYTES) throw extractorFailed();
  if (!isRedditMediaUrl(manifestUrl, mediaId)) throw extractorFailed();
  const root = parseXml(raw);
  if (root.attributes.type && root.attributes.type.toLowerCase() !== "static") throw new AppError(API_ERROR_CODES.LIVE_NOT_SUPPORTED);
  const durationSeconds = duration(root.attributes.mediaPresentationDuration);
  if (!durationSeconds) throw extractorFailed();
  const rootBase = resolveBase(manifestUrl, root, mediaId);
  const periods = root.children.filter((node) => node.name === "Period");
  if (periods.length !== 1) throw extractorFailed();
  const period = periods[0];
  if (period.attributes.duration && duration(period.attributes.duration) !== durationSeconds) throw extractorFailed();
  const periodBase = resolveBase(rootBase, period, mediaId);
  const adaptations = period.children.filter((node) => node.name === "AdaptationSet");
  if (adaptations.length === 0 || adaptations.length > 16) throw extractorFailed();
  const representations: RedditManifestRepresentation[] = [];
  for (const adaptation of adaptations) {
    const adaptationBase = resolveBase(periodBase, adaptation, mediaId);
    const inherited = Object.freeze({
      ...(adaptation.attributes.mimeType ? { mimeType: adaptation.attributes.mimeType } : {}),
      ...(adaptation.attributes.contentType ? { contentType: adaptation.attributes.contentType } : {}),
      ...(adaptation.attributes.codecs ? { codecs: adaptation.attributes.codecs } : {}),
      ...(adaptation.attributes.width ? { width: adaptation.attributes.width } : {}),
      ...(adaptation.attributes.height ? { height: adaptation.attributes.height } : {}),
      ...(adaptation.attributes.frameRate ? { frameRate: adaptation.attributes.frameRate } : {}),
      ...(adaptation.attributes.bandwidth ? { bandwidth: adaptation.attributes.bandwidth } : {})
    });
    const children = adaptation.children.filter((node) => node.name === "Representation");
    if (children.length === 0) throw extractorFailed();
    for (const candidate of children) {
      representations.push(representation(candidate, inherited, adaptationBase, mediaId, durationSeconds));
      if (representations.length > MAX_REPRESENTATIONS) throw extractorFailed();
    }
  }
  if (
    representations.length === 0 ||
    !representations.some((candidate) => candidate.kind === "video" || candidate.kind === "progressive")
  ) throw extractorFailed();
  return Object.freeze({ mediaId, durationSeconds, representations: Object.freeze(representations) });
}

export function createRedditSilentFallbackManifest(
  locator: RedditMediaLocator,
  durationSeconds: number
): RedditManifest {
  const width = locator.width;
  const height = locator.height;
  const bitrate = locator.bitrate;
  if (
    !isRedditMediaUrl(locator.fallbackUrl, locator.mediaId) ||
    !Number.isFinite(durationSeconds) ||
    durationSeconds <= 0 ||
    durationSeconds > MAX_DURATION_SECONDS ||
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    !Number.isSafeInteger(bitrate) ||
    (width as number) <= 0 ||
    (height as number) <= 0 ||
    (bitrate as number) <= 0 ||
    (bitrate as number) > MAX_BITRATE
  ) throw extractorFailed();
  const safeWidth = width as number;
  const safeHeight = height as number;
  const safeBitrate = bitrate as number;
  const filesizeEstimateBytes = Math.ceil(safeBitrate * durationSeconds / 8);
  const representation: RedditManifestRepresentation = Object.freeze({
    identity: "fallback-video",
    url: locator.fallbackUrl,
    kind: "video",
    container: "mp4",
    videoCodec: "h264",
    width: safeWidth,
    height: safeHeight,
    bitrate: safeBitrate,
    durationSeconds,
    filesizeEstimateBytes
  });
  return Object.freeze({
    mediaId: locator.mediaId,
    durationSeconds,
    representations: Object.freeze([representation])
  });
}

function timeoutSeconds(context?: ExtractorContext): number {
  const value = context?.metadataTimeoutSeconds ?? 10;
  if (!Number.isFinite(value) || value <= 0 || value > 30) throw new TypeError("Reddit manifest timeout is invalid.");
  return value;
}

function mapManifestError(caught: unknown, signal?: AbortSignal): AppError {
  if (signal?.aborted) return new AppError(API_ERROR_CODES.JOB_CANCELLED);
  if (caught instanceof AppError) {
    if (caught.status === 504 || caught.code === API_ERROR_CODES.EXTRACTOR_TIMEOUT) {
      return new AppError(API_ERROR_CODES.EXTRACTOR_TIMEOUT);
    }
    if (
      caught.code === API_ERROR_CODES.PRIVATE_OR_LOCAL_URL ||
      caught.code === API_ERROR_CODES.LIVE_NOT_SUPPORTED ||
      caught.code === API_ERROR_CODES.JOB_CANCELLED
    ) return new AppError(caught.code);
  }
  return extractorFailed();
}

export function createRedditManifestProvider(
  options: CreateRedditManifestProviderOptions = {}
): RedditManifestProvider {
  const runner = createManifestRunner({
    fetchBody: options.fetchBody,
    maxBytes: MAX_MANIFEST_BYTES,
    maxRedirects: 2,
    defaultTimeoutSeconds: 10,
    maximumTimeoutSeconds: 30,
    requestProfile: "reddit-media-v1",
    contentTypes: new Set(["application/dash+xml", "application/xml", "text/xml"]),
    allowHostname: isRedditMediaHostname
  });
  return Object.freeze({
    async fetch(locator: RedditMediaLocator, context?: ExtractorContext): Promise<RedditManifest> {
      try {
        const manifestUrl = locator.dashManifestUrl;
        if (!manifestUrl || !isRedditMediaUrl(manifestUrl, locator.mediaId)) throw extractorFailed();
        const result = await runner.fetch(manifestUrl, {
          timeoutSeconds: timeoutSeconds(context),
          signal: context?.signal
        });
        if (!isRedditMediaUrl(result.finalUrl, locator.mediaId)) throw extractorFailed();
        return parseRedditDashManifest(result.body, result.finalUrl, locator.mediaId);
      } catch (caught) {
        throw mapManifestError(caught, context?.signal);
      }
    }
  });
}

export const redditManifestProvider = createRedditManifestProvider();
