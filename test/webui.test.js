import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

const upstream = http.createServer(async (request, response) => {
  const body = request.url?.includes("/CheckLoginStatus")
    ? { code: 0, data: { isLogin: true, qrcodeurl: "https://example.test/qr" } }
    : request.url?.includes("/GetQQLoginQrcode")
      ? { code: 0, data: { qrcode: "https://example.test/qr" } }
      : request.url?.includes("/GetQQLoginInfo")
        ? { code: 0, data: { user_id: 123456, nickname: "测试账号", online: true } }
      : request.url?.includes("/auth/login")
          ? { code: 0, data: { Credential: "credential-from-test" } }
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

  const start = await fetch(`${base}/api/login/start`, { method: "POST", body: "{}" });
  const cookie = String(start.headers.get("set-cookie") || "").split(";", 1)[0];
  const task = (await start.json()).task;
  assert.equal(start.status, 200);
  assert.equal(task.mode, "webui-api");
  assert.equal(task.webuiUrl, undefined);
  assert.match(task.qrImage, /^data:image\/png;base64,/);

  const status = await fetch(`${base}/api/login/status/${task.id}`, { headers: { Cookie: cookie } });
  const statusBody = await status.json();
  assert.equal(statusBody.task.status, "success");
  assert.equal(statusBody.task.user.user_id, 123456);

  const user = await fetch(`${base}/api/user`, { headers: { Cookie: cookie } });
  assert.equal((await user.json()).user.nickname, "测试账号");

  const miniStart = await fetch(`${base}/api/miniapp/start`, {
    method: "POST",
    headers: { Cookie: cookie, "Content-Type": "application/json" },
    body: JSON.stringify({ appId: "wx_123" })
  });
  const miniTask = (await miniStart.json()).task;
  assert.equal(miniStart.status, 200);
  assert.equal(miniTask.appId, "wx_123");
});
