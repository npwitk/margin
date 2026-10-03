import { spawn } from "node:child_process";

export interface RunResult {
  code: number | null;
  output: string;
  timedOut: boolean;
}

const MAX_OUTPUT = 2 * 1024 * 1024;

/** Run a command in its own process group so a timeout kills TeX and everything it spawned. */
export function run(cmd: string, args: string[], opts: { cwd: string; env?: NodeJS.ProcessEnv; timeoutMs: number }): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd: opts.cwd, env: opts.env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    let timedOut = false;
    const collect = (b: Buffer) => {
      if (output.length < MAX_OUTPUT) output += b.toString("utf8");
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    const timer = setTimeout(() => {
      timedOut = true;
      try { process.kill(-child.pid!, "SIGKILL"); } catch { /* already gone */ }
    }, opts.timeoutMs);
    child.on("error", (err) => { clearTimeout(timer); reject(err); });
    child.on("close", (code) => { clearTimeout(timer); resolve({ code, output, timedOut }); });
  });
}
