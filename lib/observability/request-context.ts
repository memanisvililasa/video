import "server-only";
import { AsyncLocalStorage } from "node:async_hooks";
import type { ObservedHttpMethod, ObservedHttpRoute } from "@/lib/observability/contract";
import { isValidRequestId } from "@/lib/observability/request-id";

export type RequestContext = Readonly<{
  requestId: string;
  route: ObservedHttpRoute;
  method: ObservedHttpMethod;
  publicJobId?: string;
}>;

const requestStorage = new AsyncLocalStorage<RequestContext>();

export function currentRequestContext(): RequestContext | undefined {
  return requestStorage.getStore();
}

export function runWithRequestContext<T>(context: RequestContext, operation: () => T): T {
  if (!isValidRequestId(context.requestId)) throw new TypeError("Request context contains an invalid request ID.");
  return requestStorage.run(Object.freeze({ ...context }), operation);
}

export function runWithoutRequestContext<T>(operation: () => T): T {
  return requestStorage.run(undefined as never, operation);
}

export function runWithPublicJobId<T>(publicJobId: string, operation: () => T): T {
  if (!/^job_[a-zA-Z0-9_-]{1,124}$/.test(publicJobId)) {
    throw new TypeError("Request context contains an invalid public job ID.");
  }
  const current = currentRequestContext();
  if (!current) return operation();
  return requestStorage.run(Object.freeze({ ...current, publicJobId }), operation);
}
