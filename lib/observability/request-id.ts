import "server-only";
import { randomBytes } from "node:crypto";
import { REQUEST_ID_HEADER } from "@/lib/observability/contract";

export const REQUEST_ID_PATTERN = /^[a-f0-9]{32}$/;
export const REQUEST_ID_MAX_LENGTH = 32;

export type RequestIdGenerator = () => string;

export function isValidRequestId(value: string): boolean {
  return value.length === REQUEST_ID_MAX_LENGTH && REQUEST_ID_PATTERN.test(value);
}

export function generateRequestId(random: RequestIdGenerator = () => randomBytes(16).toString("hex")): string {
  const generated = random();
  if (!isValidRequestId(generated)) throw new TypeError("Request ID generator returned an invalid identifier.");
  return generated;
}

export function resolveRequestId(
  headers: Pick<Headers, "get">,
  random?: RequestIdGenerator
): Readonly<{ requestId: string; acceptedInbound: boolean }> {
  let inbound: string | null = null;
  try {
    inbound = headers.get(REQUEST_ID_HEADER);
  } catch {
    inbound = null;
  }
  if (
    inbound !== null &&
    inbound.length <= REQUEST_ID_MAX_LENGTH &&
    !inbound.includes(",") &&
    isValidRequestId(inbound)
  ) {
    return Object.freeze({ requestId: inbound, acceptedInbound: true });
  }
  return Object.freeze({ requestId: generateRequestId(random), acceptedInbound: false });
}
