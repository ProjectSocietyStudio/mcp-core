import { spawn } from "node:child_process";

export interface RunOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** Kills the process past this deadline (ms). 0 or undefined means no timeout. */
  timeoutMs?: number;
  /**
   * Written to the child's stdin, which is then closed.
   *
   * stdin is closed even when this is undefined. A child that reads until EOF -- any
   * `sys.stdin.read()`, any `cat` -- otherwise waits forever on a pipe nobody will ever
   * write to, and the symptom is a timeout rather than anything pointing at stdin.
   */
  input?: string;
}

export interface RunResult {
  /** Exit code, or null when killed by a signal or timeout. */
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/**
 * Runs a command without a shell (explicit argv) and collects stdout/stderr and the exit
 * code. Never rejects on a non-zero code: callers interpret it, because the programs we
 * drive encode meaning there. The Source compilers print their usage banner and exit 1
 * when called with no arguments, which is a success for a probe; the repo's shell
 * scripts likewise carry their verdict in the code.
 */
export function run(
  command: string,
  args: readonly string[],
  opts: RunOptions = {},
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: opts.cwd, env: opts.env ?? process.env });

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let timer: NodeJS.Timeout | undefined;

    if (opts.timeoutMs && opts.timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
      }, opts.timeoutMs);
    }

    // Always end stdin: a child reading to EOF would otherwise hang until the timeout.
    if (opts.input !== undefined) child.stdin.write(opts.input);
    child.stdin.end();
    // A child that exits before draining its stdin makes the write fail; that is its
    // choice to make, and the exit code is what the caller is waiting on.
    child.stdin.on("error", () => undefined);

    child.stdout.on("data", (d: Buffer) => (stdout += d.toString("utf8")));
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString("utf8")));
    child.on("error", (err) => {
      if (timer) clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut });
    });
  });
}
