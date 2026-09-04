import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

const upstream = http.createServer((request, response) => {
  const body = request.url?.includes("/CheckLoginStatus")
    ? { code: 0, data: { isLogin: true, qrcodeurl: "https://example.test/qr" } }
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
              : request.url?.includes("/api/qq/logout")
                ? { ok: true, loggedOut: true, method: "test-offline" }
                : { code: 0, data: null };
  response.writeHead(200, { "Content-Type": "application/json" });
  response.end(JSON.stringify(body));
});
await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
const upstreamPort = upstream.address().port;
process.env.NAPCAT_WEBUI_API_URL = `http://127.0.0.1:${upstreamPort}/api`;
process.env.NAPCAT_WEBUI_TOKEN = "serial-webui-token";
process.env.NAPCAT_API_URL = "http://127.0.0.1:1";
process.env.BRIDGE_URL = `http://127.0.0.1:${upstreamPort}`;

const { createServer } = await import(`../server.js?serial-test=${Date.now()}`);

function sessionCookie(response) {
  return String(response.headers.get("set-cookie") || "").split(";", 1)[0];
}

test("serializes users and logs QQ out after a real mini-app code", async (t) => {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    server.close();
    upstream.close();
  });
  const base = `http://127.0.0.1:${server.address().port}`;

  const firstStart = await fetch(`${base}/api/qq/login/qrcode`, { method: "POST" });
  const secondStart = await fetch(`${base}/api/qq/login/qrcode`, { method: "POST" });
  const firstCookie = sessionCookie(firstStart);
  const secondCookie = sessionCookie(secondStart);
  const firstBody = await firstStart.json();
  const secondBody = await secondStart.json();
  assert.equal(firstStart.status, 200);
  assert.equal(firstBody.task.state, "waiting_scan");
  const repeatStart = await fetch(`${base}/api/qq/login/qrcode`, { method: "POST", headers: { Cookie: firstCookie } });
  assert.equal(repeatStart.status, 200);
  assert.equal((await repeatStart.json()).task.id, firstBody.task.id);
  assert.equal(secondStart.status, 409);
  assert.equal(secondBody.code, "WORKFLOW_BUSY");
  assert.notEqual(firstCookie, secondCookie);

  const secondUser = await fetch(`${base}/api/user`, { headers: { Cookie: secondCookie } });
  assert.equal(secondUser.status, 409);
  assert.equal((await secondUser.json()).code, "WORKFLOW_BUSY");
  const crossTask = await fetch(`${base}/api/qq/login/status/${firstBody.task.id}`, { headers: { Cookie: secondCookie } });
  assert.equal(crossTask.status, 404);

  const loginStatus = await fetch(`${base}/api/qq/login/status/${firstBody.task.id}`, { headers: { Cookie: firstCookie } });
  const loginBody = await loginStatus.json();
  assert.equal(loginStatus.status, 200);
  assert.equal(loginBody.state, "confirmed");

  const miniStart = await fetch(`${base}/api/qq/miniapp/code`, {
    method: "POST",
    headers: { Cookie: firstCookie, "Content-Type": "application/json" },
    body: JSON.stringify({ appId: "wx_serial_user" })
  });
  const miniBody = await miniStart.json();
  assert.equal(miniStart.status, 200);
  assert.equal(miniBody.status, "pending");

  const miniStatus = await fetch(`${base}/api/qq/miniapp/status/${miniBody.taskId}`, { headers: { Cookie: firstCookie } });
  const miniStatusBody = await miniStatus.json();
  assert.equal(miniStatus.status, 200);
  assert.equal(miniStatusBody.code, "serial-mini-code");
  assert.equal(miniStatusBody.logoutStatus, "success");
  assert.equal(miniStatusBody.released, true);

  const nextStart = await fetch(`${base}/api/qq/login/qrcode`, { method: "POST", headers: { Cookie: secondCookie } });
  assert.equal(nextStart.status, 200);
  assert.equal((await nextStart.json()).task.state, "waiting_scan");
});
