import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

let phase = "waiting";
const signatureHeaders = { "X-API-Signature": "qq-miniapp-auth-default-signing-secret" };
const upstream = http.createServer((request, response) => {
  const body = request.url?.includes("/CheckLoginStatus")
    ? { code: 0, data: phase === "waiting" ? { state: "waiting_scan", isLogin: "false" } : phase === "scanned" ? { state: "waiting_scan", message: "扫码成功", isLogin: "false" } : { status: "cancelled", cancelled: true, isLogin: "false", loginError: "用户取消登录" } }
    : request.url?.includes("/GetQQLoginQrcode")
      ? { code: 0, data: { qrcode: "https://example.test/qr" } }
      : request.url?.includes("/auth/login")
        ? { code: 0, data: { Credential: "state-credential" } }
        : { code: 0, data: null };
  response.writeHead(200, { "Content-Type": "application/json" });
  response.end(JSON.stringify(body));
});
await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
const upstreamPort = upstream.address().port;
process.env.NAPCAT_WEBUI_API_URL = `http://127.0.0.1:${upstreamPort}/api`;
process.env.NAPCAT_WEBUI_TOKEN = "state-webui-token";
process.env.NAPCAT_API_URL = "http://127.0.0.1:1";
process.env.BRIDGE_URL = "";

const { createServer } = await import(`../server.js?login-state-test=${Date.now()}`);

test("normalizes scanned and cancelled QR login states", async (t) => {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    server.close();
    upstream.close();
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const start = await fetch(`${base}/api/qq/login/qrcode`, { method: "POST", headers: signatureHeaders });
  const task = (await start.json()).task;

  const statusRequest = (refresh = false, trailingSlash = false) => fetch(`${base}/api/qq/login/status${trailingSlash ? "/" : ""}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...signatureHeaders },
    body: JSON.stringify({ taskId: task.id, ...(refresh ? { refresh: true } : {}) })
  });

  const waiting = await statusRequest();
  const waitingBody = await waiting.json();
  assert.equal(waitingBody.task.status, "waiting_scan");
  assert.equal(waitingBody.task.scanned, false);

  const refreshed = await statusRequest(true, true);
  const refreshedBody = await refreshed.json();
  assert.equal(refreshed.status, 200);
  assert.equal(refreshedBody.task.status, "waiting_scan");
  assert.equal(refreshedBody.task.scanned, false);
  assert.equal(refreshedBody.task.confirmed, false);
  assert.match(refreshedBody.task.qrImage, /^data:image\/png;base64,/);

  phase = "scanned";
  const scanned = await statusRequest();
  const scannedBody = await scanned.json();
  assert.equal(scannedBody.task.status, "scanned");
  assert.equal(scannedBody.task.scanned, true);
  assert.equal(scannedBody.task.confirmed, false);
  assert.equal(scannedBody.task.cancelled, false);

  phase = "cancelled";
  const cancelled = await statusRequest();
  const cancelledBody = await cancelled.json();
  assert.equal(cancelledBody.task.status, "cancelled");
  assert.equal(cancelledBody.task.cancelled, true);
});
