import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ resolveWebApiRuntime: vi.fn() }));

vi.mock("@/lib/web/runtime-resolver", () => ({
  resolveWebApiRuntime: mocks.resolveWebApiRuntime
}));

import { POST as downloadPost } from "@/app/api/download/route";
import { GET as fileGet } from "@/app/api/file/[id]/route";
import { DELETE as jobDelete, GET as jobGet } from "@/app/api/jobs/[id]/route";

describe("API route import safety", () => {
  it("does not resolve local or production infrastructure while importing route modules", () => {
    expect(downloadPost).toBeTypeOf("function");
    expect(jobGet).toBeTypeOf("function");
    expect(jobDelete).toBeTypeOf("function");
    expect(fileGet).toBeTypeOf("function");
    expect(mocks.resolveWebApiRuntime).not.toHaveBeenCalled();
  });
});
