import { describe, expect, it } from "vitest";
import { run } from "../src/proc/run.js";

describe("run", () => {
  it("collects stdout and the exit code", async () => {
    const r = await run("node", ["-e", "process.stdout.write('hi')"]);
    expect(r.stdout).toBe("hi");
    expect(r.code).toBe(0);
    expect(r.timedOut).toBe(false);
  });

  it("does not reject on a non-zero exit", async () => {
    // The programs we drive carry their verdict in the code: the Source compilers
    // print their usage banner and exit 1, which is a success for a probe.
    const r = await run("node", ["-e", "process.exit(3)"]);
    expect(r.code).toBe(3);
  });

  it("feeds stdin and closes it", async () => {
    const r = await run(
      "node",
      ["-e", "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>process.stdout.write(s.toUpperCase()))"],
      { input: "hello" },
    );
    expect(r.stdout).toBe("HELLO");
  });

  it("closes stdin even with no input, so a reader cannot hang", async () => {
    // The negative control for the line above, and the bug that produced it: the
    // Python sidecar does sys.stdin.read(), which waits for EOF. Without the close
    // this call never returns and the symptom is a timeout that says nothing about
    // stdin. A short timeout here would fail loudly rather than hang the suite.
    const r = await run(
      "node",
      ["-e", "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>process.stdout.write('eof:'+s.length))"],
      { timeoutMs: 5_000 },
    );
    expect(r.timedOut).toBe(false);
    expect(r.stdout).toBe("eof:0");
  });

  it("kills a child past the deadline and says so", async () => {
    const r = await run("node", ["-e", "setTimeout(()=>{},60000)"], { timeoutMs: 300 });
    expect(r.timedOut).toBe(true);
  });

  it("rejects when the command does not exist", async () => {
    await expect(run("definitely-not-a-command-42", [])).rejects.toThrow();
  });
});
