import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "qq-miniapp-auth-"));
const qrPath = path.join(tempDir, "qrcode.png");
await fs.writeFile(qrPath, Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64"
));

let loginChecks = 0;
const signatureHeaders = { "X-API-Signature": "qq-miniapp-auth-default-signing-secret" };
const upstream = http.createServer((request, response) => {
  if (request.url === "/get_login_info") {
    loginChecks += 1;
    const payload = loginChecks > 1
      ? { retcode: 0, data: { user_id: 123456, nickname: "文件二维码账号" } }
      : { retcode: 1, message: "not logged in" };
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify(payload));
    return;
  }
  response.writeHead(404, { "Content-Type": "application/json" });
  response.end(JSON.stringify({ retcode: 404 }));
});
await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));

process.env.NAPCAT_API_URL = `http://127.0.0.1:${upstream.address().port}`;
process.env.NAPCAT_TOKEN = "";
process.env.NAPCAT_WEBUI_TOKEN = "";
process.env.NAPCAT_WEBUI_CREDENTIAL = "";
process.env.NAPCAT_WEBUI_CONFIG = path.join(tempDir, "missing-webui.json");
process.env.NAPCAT_QR_IMAGE_PATH = qrPath;
process.env.BRIDGE_URL = "";

const { createServer } = await import(`../server.js?qr-file-test=${Date.now()}`);

test("displays NapCat's real QR file without redirecting to WebUI", async (t) => {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.close();
    upstream.close();
    await fs.rm(tempDir, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${server.address().port}`;

  const start = await fetch(`${base}/api/qq/login/qrcode`, { method: "POST", body: "{}", headers: signatureHeaders });
  const body = await start.json();
  assert.equal(start.status, 200);
  assert.equal(body.task.type, "qq-login");
  assert.match(body.task.qrImage, /^data:image\/png;base64,/);
  assert.equal(body.task.mode, undefined);

  const status = await fetch(`${base}/api/qq/login/status`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...signatureHeaders },
    body: JSON.stringify({ taskId: body.task.id })
  });
  const statusBody = await status.json();
  assert.equal(statusBody.task.status, "confirmed");
  assert.equal("user" in statusBody.task, false);
});
