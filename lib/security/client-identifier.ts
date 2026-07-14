import { isIP } from "node:net";
import { env, type TrustProxyMode } from "@/lib/config/env";

export const UNIDENTIFIED_RATE_LIMIT_CLIENT = "unidentified";
export const TRUSTED_NGINX_CLIENT_IP_HEADER = "x-videosave-client-ip";

function trustedNginxClientIdentifier(headers: Headers): string {
  const candidate = headers.get(TRUSTED_NGINX_CLIENT_IP_HEADER)?.trim();
  if (!candidate || candidate.length > 64 || isIP(candidate) === 0) {
    return UNIDENTIFIED_RATE_LIMIT_CLIENT;
  }
  return candidate.toLowerCase();
}

/**
 * Resolve the identifier used for unauthenticated HTTP rate limiting.
 *
 * NextRequest does not expose the immediate socket peer. Until a trusted
 * ingress adapter supplies that value, forwarding headers are untrusted input
 * and must not influence the limiter key.
 */
export function resolveRateLimitClientIdentifier(
  headers: Headers,
  mode: TrustProxyMode = env.trustProxyMode
): string {
  switch (mode) {
    case "none":
      return UNIDENTIFIED_RATE_LIMIT_CLIENT;
    case "nginx-single-host":
      return trustedNginxClientIdentifier(headers);
    default: {
      const exhaustive: never = mode;
      throw new TypeError(`Unsupported trust proxy mode: ${String(exhaustive)}`);
    }
  }
}
