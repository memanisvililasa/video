import { chmod, mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { AppError } from "@/lib/errors";
import {
  APPROVED_YT_DLP_VERSION,
  YT_DLP_EXTRACTOR_KEYS,
  YT_DLP_KILL_GRACE_MS,
  YT_DLP_METADATA_TIMEOUT_MS,
  YT_DLP_STDERR_MAX_BYTES,
  YT_DLP_STDOUT_MAX_BYTES,
  parseYtDlpVersionOutput,
  resolveYtDlpBinaryPath,
  type PlatformPageId
} from "@/lib/extractors/yt-dlp/contract";
import { startMetadataEgressGuard, type MetadataEgressGuard } from "@/lib/extractors/yt-dlp/egress-guard";
import { parseYtDlpMetadataJson, type ParsedPlatformMetadata } from "@/lib/extractors/yt-dlp/parser";
import {
  BoundedProcessError,
  runBoundedProcess,
  type BoundedProcessResult,
  type BoundedProcessRunOptions
} from "@/lib/process/bounded-process";
import { validateOutboundHostname } from "@/lib/security/ssrf";
import { API_ERROR_CODES } from "@/lib/types";

type ProcessRunner = (options: BoundedProcessRunOptions) => Promise<BoundedProcessResult>;
type GuardFactory = (options: {
  signal?: AbortSignal;
  allowHostname?: (hostname: string) => boolean;
}) => Promise<MetadataEgressGuard>;

export type YtDlpMetadataRunnerOptions = Readonly<{
  binaryPath?: string;
  nodeEnv?: string;
  pathValue?: string;
  processRunner?: ProcessRunner;
  guardFactory?: GuardFactory;
  temporaryRoot?: string;
}>;

function assertCanonicalPageUrl(url: URL): void {
  if (url.protocol !== "https:" || url.username || url.password || url.port && url.port !== "443") {
    throw new AppError(API_ERROR_CODES.UNSUPPORTED_URL);
  }
  const safety = validateOutboundHostname(url.hostname);
  if (!safety.ok) throw new AppError(safety.code);
}

function isolatedEnvironment(scratch: string, pathValue: string | undefined, needsPath: boolean): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {
    HOME: path.join(/* turbopackIgnore: true */ scratch, "home"),
    XDG_CACHE_HOME: path.join(/* turbopackIgnore: true */ scratch, "cache"),
    XDG_CONFIG_HOME: path.join(/* turbopackIgnore: true */ scratch, "config"),
    XDG_DATA_HOME: path.join(/* turbopackIgnore: true */ scratch, "data"),
    TMPDIR: path.join(/* turbopackIgnore: true */ scratch, "tmp"),
    LANG: "C",
    LC_ALL: "C",
    NO_COLOR: "1",
    NODE_ENV: "production"
  };
  if (needsPath && pathValue) environment.PATH = pathValue;
  return environment;
}

function versionArguments(): readonly string[] {
  return Object.freeze([
    "--ignore-config",
    "--no-config-locations",
    "--no-plugin-dirs",
    "--no-remote-components",
    "--no-cookies",
    "--no-cookies-from-browser",
    "--no-netrc",
    "--version"
  ]);
}

function metadataArguments(platform: PlatformPageId, proxyUrl: string, pageUrl: URL): readonly string[] {
  const extractor = YT_DLP_EXTRACTOR_KEYS[platform][0];
  return Object.freeze([
    "--ignore-config",
    "--no-config-locations",
    "--no-plugin-dirs",
    "--no-remote-components",
    "--no-js-runtimes",
    "--no-cookies",
    "--no-cookies-from-browser",
    "--no-netrc",
    "--no-cache-dir",
    "--no-download-archive",
    "--no-exec",
    "--no-playlist",
    "--skip-download",
    "--dump-single-json",
    "--no-check-formats",
    "--socket-timeout", "10",
    "--retries", "0",
    "--fragment-retries", "0",
    "--file-access-retries", "0",
    "--max-downloads", "1",
    "--xff", "never",
    "--proxy", proxyUrl,
    "--geo-verification-proxy", proxyUrl,
    "--color", "never",
    "--no-progress",
    "--use-extractors", extractor,
    "--",
    pageUrl.toString()
  ]);
}

const VIMEO_METADATA_HOST_SUFFIXES = Object.freeze(["vimeo.com", "vimeocdn.com"]);

function isAllowedMetadataHostname(platform: PlatformPageId, hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/\.$/, "");
  if (platform !== "vimeo") return false;
  return VIMEO_METADATA_HOST_SUFFIXES.some((suffix) =>
    normalized === suffix || normalized.endsWith(`.${suffix}`)
  );
}

export function mapYtDlpProcessError(error: unknown): AppError {
  if (error instanceof BoundedProcessError) {
    if (error.reason === "timeout") return new AppError(API_ERROR_CODES.EXTRACTOR_TIMEOUT);
    if (error.reason === "aborted") return new AppError(API_ERROR_CODES.JOB_CANCELLED);
    const stderr = error.stderr.toLowerCase();
    if (/password(?:-protected| protected| required)|enter password/.test(stderr)) {
      return new AppError(API_ERROR_CODES.PRIVATE_CONTENT);
    }
    if (/private video|video is private|privacy settings/.test(stderr)) {
      return new AppError(API_ERROR_CODES.PRIVATE_CONTENT);
    }
    if (/login required|sign in|log in|authentication required|use --cookies/.test(stderr)) {
      return new AppError(API_ERROR_CODES.LOGIN_REQUIRED);
    }
    if (/\bdrm\b|digital rights management/.test(stderr)) {
      return new AppError(API_ERROR_CODES.DRM_PROTECTED);
    }
    if (/geo(?:graphically)? restricted|not available in your country|not available in your region/.test(stderr)) {
      return new AppError(API_ERROR_CODES.GEO_RESTRICTED);
    }
    if (/age[- ]restricted|confirm your age|age verification/.test(stderr)) {
      return new AppError(API_ERROR_CODES.AGE_RESTRICTED);
    }
    if (/video (?:has been removed|does not exist|is unavailable)|not found|http error 404/.test(stderr)) {
      return new AppError(API_ERROR_CODES.CONTENT_UNAVAILABLE);
    }
    return new AppError(API_ERROR_CODES.EXTRACTOR_FAILED);
  }
  return error instanceof AppError ? error : new AppError(API_ERROR_CODES.EXTRACTOR_FAILED);
}

async function createScratch(root: string): Promise<string> {
  const scratch = await mkdtemp(path.join(/* turbopackIgnore: true */ root, "videosave-ytdlp-"));
  await chmod(scratch, 0o700);
  await Promise.all(["home", "cache", "config", "data", "tmp"].map((name) =>
    mkdir(path.join(/* turbopackIgnore: true */ scratch, name), { recursive: true, mode: 0o700 })
  ));
  return scratch;
}

export function createYtDlpMetadataRunner(options: YtDlpMetadataRunnerOptions = {}) {
  const nodeEnv = options.nodeEnv ?? process.env.NODE_ENV ?? "development";
  const binaryPath = resolveYtDlpBinaryPath(options.binaryPath ?? process.env.YT_DLP_PATH, nodeEnv);
  const processRunner = options.processRunner ?? runBoundedProcess;
  const guardFactory = options.guardFactory ?? startMetadataEgressGuard;
  const temporaryRoot = options.temporaryRoot ?? os.tmpdir();
  if (!path.isAbsolute(temporaryRoot) || temporaryRoot.includes("\0")) {
    throw new TypeError("yt-dlp temporary root must be an absolute path.");
  }
  const pathValue = options.pathValue ?? process.env.PATH;
  let verifiedVersion: Promise<string> | undefined;

  const runVersionCheck = async (): Promise<string> => {
    const scratch = await createScratch(temporaryRoot);
    try {
      const result = await processRunner({
        command: binaryPath,
        args: versionArguments(),
        cwd: scratch,
        env: isolatedEnvironment(scratch, pathValue, !path.isAbsolute(binaryPath)),
        timeoutMs: 10_000,
        killGraceMs: YT_DLP_KILL_GRACE_MS,
        stdoutMaxBytes: 1_024,
        stderrMaxBytes: YT_DLP_STDERR_MAX_BYTES
      });
      return parseYtDlpVersionOutput(result.stdout);
    } catch (error) {
      if (error instanceof TypeError) throw new AppError(API_ERROR_CODES.EXTRACTOR_FAILED);
      if (error instanceof BoundedProcessError && error.reason === "timeout") {
        throw new AppError(API_ERROR_CODES.EXTRACTOR_TIMEOUT);
      }
      throw new AppError(API_ERROR_CODES.EXTRACTOR_FAILED);
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  };

  return Object.freeze({
    binaryPath,
    approvedVersion: APPROVED_YT_DLP_VERSION,
    async checkVersion(): Promise<string> {
      verifiedVersion ??= runVersionCheck().catch((error) => {
        verifiedVersion = undefined;
        throw error;
      });
      return verifiedVersion;
    },
    async extract(platform: PlatformPageId, pageUrl: URL, signal?: AbortSignal): Promise<ParsedPlatformMetadata> {
      assertCanonicalPageUrl(pageUrl);
      await this.checkVersion();
      if (signal?.aborted) throw new AppError(API_ERROR_CODES.JOB_CANCELLED);
      const scratch = await createScratch(temporaryRoot);
      let guard: MetadataEgressGuard | undefined;
      try {
        guard = await guardFactory({
          signal,
          allowHostname: (hostname) => isAllowedMetadataHostname(platform, hostname)
        });
        const result = await processRunner({
          command: binaryPath,
          args: metadataArguments(platform, guard.proxyUrl, pageUrl),
          cwd: scratch,
          env: isolatedEnvironment(scratch, pathValue, !path.isAbsolute(binaryPath)),
          timeoutMs: YT_DLP_METADATA_TIMEOUT_MS,
          killGraceMs: YT_DLP_KILL_GRACE_MS,
          stdoutMaxBytes: YT_DLP_STDOUT_MAX_BYTES,
          stderrMaxBytes: YT_DLP_STDERR_MAX_BYTES,
          signal
        });
        return parseYtDlpMetadataJson(result.stdout, platform);
      } catch (error) {
        throw mapYtDlpProcessError(error);
      } finally {
        await guard?.close();
        await rm(scratch, { recursive: true, force: true });
      }
    }
  });
}
