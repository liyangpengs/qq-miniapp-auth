import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

let phase = "scanned";
const upstream = http.createServer((request, response) => {
  const body = request.url?.includes("/CheckLoginStatus")
    ? { code: 0, data: phase === "scanned" ? { status: "scanned", isLogin: false } : { status: "cancelled", cancelled: true, isLogin: false, loginError: "用户取消登录" } }
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
  const start = await fetch(`${base}/api/qq/login/qrcode`, { method: "POST" });
  const cookie = String(start.headers.get("set-cookie") || "").split(";", 1)[0];
  const task = (await start.json()).task;

  const scanned = await fetch(`${base}/api/qq/login/status/${task.id}`, { headers: { Cookie: cookie } });
  const scannedBody = await scanned.json();
  assert.equal(scannedBody.state, "scanned");
  assert.equal(scannedBody.scanned, true);
  assert.equal(scannedBody.confirmed, false);
  assert.equal(scannedBody.cancelled, false);

  phase = "cancelled";
  const cancelled = await fetch(`${base}/api/qq/login/status/${task.id}`, { headers: { Cookie: cookie } });
  const cancelledBody = await cancelled.json();
  assert.equal(cancelledBody.status, "cancelled");
  assert.equal(cancelledBody.state, "cancelled");
  assert.equal(cancelledBody.cancelled, true);
});
