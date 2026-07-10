import type { ChildProcess, SpawnOptions } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

export type SpawnCall = {
  command: string;
  args: readonly string[];
  options: SpawnOptions;
};

export class FakeChildProcess extends EventEmitter {
  public pid: number | undefined = 4321;
  public stdout: PassThrough | null = new PassThrough();
  public stderr: PassThrough | null = new PassThrough();

  asChildProcess(): ChildProcess {
    return this as unknown as ChildProcess;
  }

  writeStdout(value: string | Buffer): void {
    this.stdout?.write(value);
  }

  writeStderr(value: string | Buffer): void {
    this.stderr?.write(value);
  }

  emitFailure(code: string): void {
    const error = Object.assign(new Error("Fake spawn failure"), { code });
    this.emit("error", error);
  }

  emitClose(exitCode: number | null, signal: NodeJS.Signals | null = null): void {
    this.stdout?.end();
    this.stderr?.end();
    this.emit("close", exitCode, signal);
  }
}

export function createSpawnRecorder(child: FakeChildProcess, calls: SpawnCall[]) {
  return (command: string, args: readonly string[], options: SpawnOptions): ChildProcess => {
    calls.push({ command, args: [...args], options });
    return child.asChildProcess();
  };
}
