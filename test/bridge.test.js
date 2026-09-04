import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

const pluginAuthHeaders = [];
const upstream = http.createServer((request, response) => {
  const chunks = [];
  request.on("data", (chunk) => chunks.push(chunk));
  request.on("end", () => {
    let body = {};
    try { body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"); } catch { /* ignore */ }
    let payload;
    if (request.url === "/get_login_info") {
      payload = { retcode: 0, data: { user_id: 123456, nickname: "测试账号" } };
    } else if (request.url === "/plugin/miniapp") {
      pluginAuthHeaders.push(request.headers.authorization || "");
      payload = { ok: true, appId: body.appId, operation: "loginWithAppId", code: "auth-code-1", openId: "openid-1" };
    } else if (request.url === "/plugin/logout") {
      pluginAuthHeaders.push(request.headers.authorization || "");
      payload = { ok: true, loggedOut: true, method: "NodeIKernelLoginService.offline" };
    } else {
      payload = { retcode: 404, message: "not found" };
    }
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify(payload));
  });
});
await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
process.env.NAPCAT_API_URL = `http://127.0.0.1:${upstream.address().port}`;
process.env.NAPCAT_TOKEN = "napcat-test-token";
process.env.NAPCAT_OPEN_AUTH_PLUGIN_URL = `http://127.0.0.1:${upstream.address().port}/plugin`;
process.env.NAPCAT_OPEN_AUTH_PLUGIN_TOKEN = "plugin-test-token";
process.env.BRIDGE_HOST = "127.0.0.1";
process.env.BRIDGE_TOKEN = "bridge-test-token";

const { createBridgeServer, extractOpenAuthCode } = await import(`../bridge.js?bridge-test=${Date.now()}`);

test("bridge accepts the explicit code returned by loginWithAppId", () => {
  const result = extractOpenAuthCode({
    ok: true,
    appId: "1112386029",
    operation: "loginWithAppId",
    method: "loginWithAppId",
    code: "25305db36442c75e6605359db645548b",
    result: { errCode: 0, errMsg: "", result: "25305db36442c75e6605359db645548b" }
  });
  assert.equal(result.code, "25305db36442c75e6605359db645548b");
  assert.equal(result.resultCode, 0);
});

test("bridge obtains a mini-app authorization code through NapCat OpenAuth", async (t) => {
  const server = createBridgeServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    server.close();
    upstream.close();
  });
  const base = `http://127.0.0.1:${server.address().port}`;

  const health = await fetch(`${base}/health`);
  const healthBody = await health.json();
  assert.equal(health.status, 200);
  assert.equal(healthBody.provider, "napcat-openauth-plugin");
  assert.equal("qqntControlUrl" in healthBody, false);
  assert.equal("qqntControlEnabled" in healthBody, false);

  const unauthorized = await fetch(`${base}/api/miniapp/login/start`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ appId: "1108291530" })
  });
  assert.equal(unauthorized.status, 401);

  const start = await fetch(`${base}/api/miniapp/login/start`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer bridge-test-token" },
    body: JSON.stringify({ appId: "1108291530" })
  });
  assert.equal(start.status, 200);
  const task = await start.json();
  assert.equal(task.appId, "1108291530");
  assert.equal(task.status, "pending");

  let result;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const status = await fetch(`${base}/api/miniapp/login/status/${task.taskId}`, {
      headers: { Authorization: "Bearer bridge-test-token" }
    });
    result = await status.json();
    assert.equal(status.status, 200);
    if (result.status === "success") break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(result.status, "success");
  assert.equal(result.code, "auth-code-1");
  assert.equal(result.openId, "openid-1");
  assert.equal(result.uin, "123456");
  assert.deepEqual(pluginAuthHeaders, ["Bearer plugin-test-token"]);

  const logout = await fetch(`${base}/api/qq/logout`, {
    method: "POST",
    headers: { Authorization: "Bearer bridge-test-token" }
  });
  assert.equal(logout.status, 200);
  assert.equal((await logout.json()).loggedOut, true);
});
