import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

let upstreamLoginState = true;
const signatureHeaders = { "X-API-Signature": "qq-miniapp-auth-default-signing-secret" };
const upstream = http.createServer(async (request, response) => {
  const body = request.url?.includes("/CheckLoginStatus")
    ? { code: 0, data: { isLogin: upstreamLoginState, qrcodeurl: "https://example.test/qr" } }
    : request.url?.includes("/GetQQLoginQrcode")
      ? { code: 0, data: { qrcode: "https://example.test/qr" } }
      : request.url?.includes("/GetQQLoginInfo")
        ? { code: 0, data: { user_id: 123456, nickname: "测试账号", online: true } }
      : request.url?.includes("/auth/login")
          ? { code: 0, data: { Credential: "credential-from-test" } }
          : request.url?.includes("/api/miniapp/login/start")
            ? { taskId: "webui-mini-task", status: "pending" }
            : request.url?.includes("/api/miniapp/login/status/")
              ? { status: "success", code: "webui-mini-code", user: { uin: "123456" } }
              : request.url?.includes("/QQLogin/RestartNapCat")
                ? (upstreamLoginState = false, { code: 0, data: { message: "restart accepted" } })
          : request.url?.includes("/api/qq/logout")
            ? { ok: true, loggedOut: true, method: "test-offline" }
          : { code: 0, data: null };
  response.writeHead(200, { "Content-Type": "application/json" });
  response.end(JSON.stringify(body));
});
await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
const upstreamPort = upstream.address().port;
process.env.NAPCAT_WEBUI_API_URL = `http://127.0.0.1:${upstreamPort}/api`;
process.env.NAPCAT_WEBUI_TOKEN = "test-webui-token";
process.env.NAPCAT_API_URL = "http://127.0.0.1:1";
// Account login must use NapCat WebUI even when the mini-app bridge is configured.
process.env.BRIDGE_URL = `http://127.0.0.1:${upstreamPort}`;

const { createServer } = await import(`../server.js?webui-test=${Date.now()}`);

test("uses NapCat WebUI endpoints for QR and current user", async (t) => {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    server.close();
    upstream.close();
  });
  const base = `http://127.0.0.1:${server.address().port}`;

  const start = await fetch(`${base}/api/qq/login/qrcode`, { method: "POST", body: "{}", headers: signatureHeaders });
  const startBody = await start.json();
  const task = startBody.task;
  assert.equal(start.status, 200);
  assert.equal("taskId" in startBody, false);
  assert.equal("status" in startBody, false);
  assert.equal(task.type, "qq-login");
  assert.equal(task.mode, undefined);
  assert.match(task.qrImage, /^data:image\/png;base64,/);

  const status = await fetch(`${base}/api/qq/login/status/`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...signatureHeaders },
    body: JSON.stringify({ taskId: task.id })
  });
  const statusBody = await status.json();
  assert.equal(statusBody.task.status, "confirmed");
  assert.equal("user" in statusBody.task, false);

  const miniStart = await fetch(`${base}/api/qq/miniapp/code`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...signatureHeaders },
    body: JSON.stringify({ appId: "wx_123", taskId: task.id })
  });
  const miniBody = await miniStart.json();
  assert.equal(miniStart.status, 200);
  assert.equal(miniBody.ok, true);
  assert.equal(miniBody.code, "webui-mini-code");
  assert.equal("task" in miniBody, false);
});
