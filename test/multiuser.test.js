import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

const upstream = http.createServer((request, response) => {
  const body = request.url?.includes("/CheckLoginStatus")
    ? { code: 0, data: { isLogin: upstreamLoginState, qrcodeurl: "https://example.test/qr" } }
    : request.url?.includes("/GetQQLoginQrcode")
      ? { code: 0, data: { qrcode: "https://example.test/qr" } }
      : request.url?.includes("/GetQQLoginInfo")
        ? { code: 0, data: { user_id: 123456, nickname: "serial-user", online: true } }
        : request.url?.includes("/auth/login")
          ? { code: 0, data: { Credential: "serial-credential" } }
          : request.url?.includes("/api/miniapp/login/start")
            ? { taskId: "bridge-task", status: "pending" }
            : request.url?.includes("/api/miniapp/login/status/")
              ? { status: "success", code: "serial-mini-code", user: { uin: "123456" } }
              : request.url?.includes("/QQLogin/RestartNapCat")
                ? (upstreamLoginState = false, { code: 0, data: { message: "restart accepted" } })
                : request.url?.includes("/api/qq/logout")
                ? { ok: true, loggedOut: true, method: "test-offline" }
                : { code: 0, data: null };
  response.writeHead(200, { "Content-Type": "application/json" });
  response.end(JSON.stringify(body));
});
const signatureHeaders = { "X-API-Signature": "qq-miniapp-auth-default-signing-secret" };
let upstreamLoginState = true;
await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
const upstreamPort = upstream.address().port;
process.env.NAPCAT_WEBUI_API_URL = `http://127.0.0.1:${upstreamPort}/api`;
process.env.NAPCAT_WEBUI_TOKEN = "serial-webui-token";
process.env.NAPCAT_API_URL = "http://127.0.0.1:1";
process.env.BRIDGE_URL = `http://127.0.0.1:${upstreamPort}`;

const { createServer } = await import(`../server.js?serial-test=${Date.now()}`);

test("serializes users and logs QQ out after a real mini-app code", async (t) => {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    server.close();
    upstream.close();
  });
  const base = `http://127.0.0.1:${server.address().port}`;

  const firstStart = await fetch(`${base}/api/qq/login/qrcode`, { method: "POST", headers: signatureHeaders });
  const secondStart = await fetch(`${base}/api/qq/login/qrcode`, { method: "POST", headers: signatureHeaders });
  const firstBody = await firstStart.json();
  const secondBody = await secondStart.json();
  assert.equal(firstStart.status, 200);
  assert.equal(firstBody.task.status, "waiting_scan");
  const repeatStart = await fetch(`${base}/api/qq/login/qrcode`, { method: "POST", headers: signatureHeaders });
  assert.equal(repeatStart.status, 200);
  assert.equal(secondStart.status, 200);
  assert.equal(secondBody.code, "WORKFLOW_BUSY");
  assert.equal(secondBody.ok, false);
  const crossTask = await fetch(`${base}/api/qq/login/status`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...signatureHeaders },
    body: JSON.stringify({ taskId: firstBody.task.id })
  });
  assert.equal(crossTask.status, 200);

  const loginStatus = await fetch(`${base}/api/qq/login/status`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...signatureHeaders },
    body: JSON.stringify({ taskId: firstBody.task.id })
  });
  const loginBody = await loginStatus.json();
  assert.equal(loginStatus.status, 200);
  assert.equal(loginBody.task.status, "confirmed");

  const miniStart = await fetch(`${base}/api/qq/miniapp/code`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...signatureHeaders },
    body: JSON.stringify({ appId: "wx_serial_user", taskId: firstBody.task.id })
  });
  const miniBody = await miniStart.json();
  assert.equal(miniStart.status, 200);
  assert.equal(miniBody.ok, true);
  assert.equal(miniBody.code, "serial-mini-code");
  assert.equal("task" in miniBody, false);

  const nextStart = await fetch(`${base}/api/qq/login/qrcode`, { method: "POST", headers: signatureHeaders });
  assert.equal(nextStart.status, 200);
  assert.equal((await nextStart.json()).task.status, "waiting_scan");
});
