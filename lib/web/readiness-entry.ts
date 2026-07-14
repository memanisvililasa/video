import "server-only";
import { runProductionWebReadiness } from "@/lib/web/readiness";

void runProductionWebReadiness(process.env).then(
  () => {
    console.info("Production web readiness passed.");
  },
  () => {
    console.error("Production web readiness failed.");
    process.exitCode = 1;
  }
);
