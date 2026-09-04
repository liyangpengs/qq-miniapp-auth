import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

dotenv.config();

const root = path.dirname(fileURLToPath(import.meta.url));
const env = { ...process.env };
if (!env.BRIDGE_URL) env.BRIDGE_URL = "http://127.0.0.1:9010";
const children = ["bridge.js", "server.js"].map((file) => {
  const child = spawn(process.execPath, [path.join(root, file)], { cwd: root, env, stdio: "inherit", windowsHide: true });
  child.on("exit", (code, signal) => {
    if (code && !signal) process.exitCode = code;
  });
  return child;
});

function shutdown(signal) {
  for (const child of children) child.kill(signal);
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
