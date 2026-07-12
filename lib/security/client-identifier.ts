import { env, type TrustProxyMode } from "@/lib/config/env";

export const UNIDENTIFIED_RATE_LIMIT_CLIENT = "unidentified";

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
  void headers;

  switch (mode) {
    case "none":
      return UNIDENTIFIED_RATE_LIMIT_CLIENT;
    default: {
      const exhaustive: never = mode;
      throw new TypeError(`Unsupported trust proxy mode: ${String(exhaustive)}`);
    }
  }
}
