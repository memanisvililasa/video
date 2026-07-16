import "@/app/globals.css";
import "vitest-browser-react";
import { afterEach, beforeEach } from "vitest";

beforeEach(() => {
  globalThis.sessionStorage.clear();
});

afterEach(() => {
  globalThis.sessionStorage.clear();
});
