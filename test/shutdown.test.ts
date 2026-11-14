// End-to-end: the built server (dist/) must not leave agy running when the client goes away.
import { describe, it, expect } from "vitest";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const FAKE_BIN = path.resolve(__dirname, "fixtures/bin");
const SERVER = path.resolve(__dirname, "../dist/index.js");

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const waitFor = async (cond: () => boolean, ms: number) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (cond()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return cond();
};

describe("shutdown", () => {
  for (const how of ["stdin close", "SIGTERM"] as const) {
    it(`kills a running agy on ${how}`, async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "zwilling-shutdown-"));
      const pidfile = path.join(dir, "agy.pid");
      const server = spawn(process.execPath, [SERVER], {
        cwd: dir,
        stdio: ["pipe", "pipe", "pipe"],
        env: {
          ...process.env,
          PATH: `${FAKE_BIN}${path.delimiter}${process.env.PATH}`,
          FAKE_AGY_MODE: "slow",
          FAKE_AGY_PIDFILE: pidfile,
        },
      });
      const send = (msg: object) => server.stdin.write(JSON.stringify(msg) + "\n");
      send({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } },
      });
      send({ jsonrpc: "2.0", method: "notifications/initialized" });
      send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "ask_gemini", arguments: { prompt: "x" } } });

      expect(await waitFor(() => fs.existsSync(pidfile) && fs.readFileSync(pidfile, "utf8") !== "", 5_000)).toBe(true);
      const agyPid = Number(fs.readFileSync(pidfile, "utf8"));
      expect(alive(agyPid)).toBe(true);

      const exited = new Promise((r) => server.on("exit", r));
      if (how === "stdin close") server.stdin.end();
      else server.kill("SIGTERM");
      await exited;

      expect(await waitFor(() => !alive(agyPid), 3_000)).toBe(true);
      fs.rmSync(dir, { recursive: true, force: true });
    });
  }
});
