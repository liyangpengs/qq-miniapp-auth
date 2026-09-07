import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

let loginState = "pending";
const signingSecret = "task-api-custom-signing-secret";
const signatureHeaders = { "X-API-Signature": signingSecret };

const upstream = http.createServer((request, response) => {
  const pathname = new URL(request.url, "http://upstream").pathname;
  const body = pathname === "/auth/login"
    ? { code: 0, data: { Credential: "task-api-credential" } }
    : pathname === "/QQLogin/GetQQLoginQrcode"
      ? { code: 0, data: { qrcode: "https://example.test/task-api-qr" } }
        : pathname === "/QQLogin/CheckLoginStatus"
          ? { code: 0, data: loginState === "logged_in" ? { status: "success", isLogin: true } : { status: "pending", isLogin: false } }
        : pathname === "/QQLogin/GetQQLoginInfo"
          ? { code: 0, data: { user_id: 778899, nickname: "task-user" } }
          : pathname === "/api/qq/logout"
            ? { ok: true, loggedOut: true, method: "test-offline" }
        : pathname === "/QQLogin/RestartNapCat"
          ? (loginState = "pending", { code: 0, data: { message: "restart accepted" } })
        : pathname === "/QQLogin/CancelLogin"
          ? { code: 0, data: { ok: true } }
          : { code: 0, data: null };
  response.writeHead(200, { "Content-Type": "application/json" });
  response.end(JSON.stringify(body));
});
await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));

const upstreamPort = upstream.address().port;
process.env.NAPCAT_WEBUI_API_URL = `http://127.0.0.1:${upstreamPort}`;
process.env.NAPCAT_WEBUI_TOKEN = "task-api-token";
process.env.NAPCAT_API_URL = "http://127.0.0.1:1";
process.env.BRIDGE_URL = `http://127.0.0.1:${upstreamPort}`;
process.env.TASK_TTL_MS = "30";
process.env.WORKFLOW_TTL_MS = "30";
process.env.API_SIGNING_SECRET = signingSecret;

const { createServer } = await import(`../server.js?task-api-test=${Date.now()}`);

test("uses taskId without cookies and auto-cancels after the task lifetime", async (t) => {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    server.close();
    upstream.close();
  });
  const base = `http://127.0.0.1:${server.address().port}`;

  const unsigned = await fetch(`${base}/api/qq/login/qrcode`, { method: "POST" });
  const unsignedBody = await unsigned.json();
  assert.equal(unsigned.status, 200);
  assert.equal(unsignedBody.ok, false);
  assert.equal(unsignedBody.code, "SIGNATURE_REQUIRED");

  const invalid = await fetch(`${base}/api/qq/login/qrcode`, {
    method: "POST",
    headers: { "X-API-Signature": "wrong-signature" }
  });
  const invalidBody = await invalid.json();
  assert.equal(invalid.status, 200);
  assert.equal(invalidBody.ok, false);
  assert.equal(invalidBody.code, "INVALID_SIGNATURE");

  const start = await fetch(`${base}/api/qq/login/qrcode`, { method: "POST", headers: signatureHeaders });
  assert.equal(start.status, 200);
  assert.equal(start.headers.has("set-cookie"), false);
  const started = await start.json();
  assert.equal("taskId" in started, false);
  assert.equal("status" in started, false);
  assert.ok(started.task.id);

  await new Promise((resolve) => setTimeout(resolve, 60));
  const status = await fetch(`${base}/api/qq/login/status`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...signatureHeaders },
    body: JSON.stringify({ taskId: started.task.id })
  });
  const body = await status.json();
  assert.equal(status.status, 200);
  assert.equal(body.ok, false);
  assert.equal(body.code, "TASK_EXPIRED");
  assert.equal(body.task.status, "expired");
  assert.equal(body.task.cancelled, true);
  assert.equal(body.task.released, true);

  const expiredCode = await fetch(`${base}/api/qq/miniapp/code`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...signatureHeaders },
    body: JSON.stringify({ appId: "wx_123", taskId: started.task.id })
  });
  const expiredCodeBody = await expiredCode.json();
  assert.equal(expiredCode.status, 200);
  assert.equal(expiredCodeBody.ok, false);
  assert.equal(expiredCodeBody.code, "TASK_EXPIRED");
  assert.equal(expiredCodeBody.status, "expired");
  assert.equal("task" in expiredCodeBody, false);

  const expiredLogout = await fetch(`${base}/api/qq/logout`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...signatureHeaders },
    body: JSON.stringify({ taskId: started.task.id })
  });
  const expiredLogoutBody = await expiredLogout.json();
  assert.equal(expiredLogout.status, 200);
  assert.equal(expiredLogoutBody.ok, false);
  assert.equal(expiredLogoutBody.code, "TASK_EXPIRED");
  assert.equal(expiredLogoutBody.status, "expired");
  assert.equal("task" in expiredLogoutBody, false);

  const missingStatus = await fetch(`${base}/api/qq/login/status`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...signatureHeaders },
    body: JSON.stringify({ taskId: "missing-login-task" })
  });
  const missingStatusBody = await missingStatus.json();
  assert.equal(missingStatus.status, 200);
  assert.equal(missingStatusBody.ok, false);
  assert.equal(missingStatusBody.code, "TASK_EXPIRED");
  assert.equal(missingStatusBody.task.status, "expired");

  const missingCode = await fetch(`${base}/api/qq/miniapp/code`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...signatureHeaders },
    body: JSON.stringify({ appId: "wx_123", taskId: "missing-login-task" })
  });
  const missingCodeBody = await missingCode.json();
  assert.equal(missingCode.status, 200);
  assert.equal(missingCodeBody.ok, false);
  assert.equal(missingCodeBody.code, "TASK_EXPIRED");
  assert.equal(missingCodeBody.status, "expired");
  assert.equal("task" in missingCodeBody, false);

  const missingLogout = await fetch(`${base}/api/qq/logout`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...signatureHeaders },
    body: JSON.stringify({ taskId: "missing-login-task" })
  });
  const missingLogoutBody = await missingLogout.json();
  assert.equal(missingLogout.status, 200);
  assert.equal(missingLogoutBody.ok, false);
  assert.equal(missingLogoutBody.code, "TASK_EXPIRED");
  assert.equal(missingLogoutBody.status, "expired");
  assert.equal("task" in missingLogoutBody, false);

  const next = await fetch(`${base}/api/qq/login/qrcode`, { method: "POST", headers: signatureHeaders });
  assert.equal(next.status, 200);
  const nextBody = await next.json();
  loginState = "logged_in";
  const loggedIn = await fetch(`${base}/api/qq/login/status`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...signatureHeaders },
    body: JSON.stringify({ taskId: nextBody.task.id })
  });
  assert.equal((await loggedIn.json()).task.status, "confirmed");

  const logout = await fetch(`${base}/api/qq/logout`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...signatureHeaders },
    body: JSON.stringify({ taskId: nextBody.task.id })
  });
  const logoutBody = await logout.json();
  assert.equal(logout.status, 200);
  assert.equal(logoutBody.ok, true);
  assert.equal("task" in logoutBody, false);

  const removedStatus = await fetch(`${base}/api/qq/login/status`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...signatureHeaders },
    body: JSON.stringify({ taskId: nextBody.task.id })
  });
  const removedStatusBody = await removedStatus.json();
  assert.equal(removedStatusBody.ok, false);
  assert.equal(removedStatusBody.code, "TASK_EXPIRED");
  assert.equal(removedStatusBody.task.status, "expired");

  loginState = "pending";
  const afterLogout = await fetch(`${base}/api/qq/login/qrcode`, { method: "POST", headers: signatureHeaders });
  assert.equal(afterLogout.status, 200);
});
