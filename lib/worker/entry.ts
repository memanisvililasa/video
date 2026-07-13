import "server-only";
import { runMediaWorkerMain } from "@/lib/worker/main";

void runMediaWorkerMain().then((code) => {
  process.exitCode = code;
});
