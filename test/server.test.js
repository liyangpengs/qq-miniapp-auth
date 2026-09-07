import test from "node:test";
import assert from "node:assert/strict";

process.env.HOST = "127.0.0.1";
process.env.BRIDGE_URL = "";
const signatureHeaders = { "X-API-Signature": "qq-miniapp-auth-default-signing-secret" };

const { createServer, validAppId } = await import("../server.js");

test("validates mini-app appIds without accepting arbitrary input", () => {
  assert.equal(validAppId("wx_123"), true);
  assert.equal(validAppId("ab"), false);
  assert.equal(validAppId("wx 123"), false);
  assert.equal(validAppId("<script>"), false);
});

test("reports real-only configuration and refuses missing bridge", async (t) => {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;

  const health = await fetch(`${base}/api/health`);
  assert.equal(health.status, 200);
  assert.equal((await health.json()).bridgeConfigured, false);

  const frontend = await fetch(`${base}/`);
  assert.equal(frontend.status, 404);

  const start = await fetch(`${base}/api/qq/miniapp/code`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...signatureHeaders },
    body: JSON.stringify({ appId: "wx_123", taskId: "missing-login-task" })
  });
  assert.equal(start.status, 200);
  const body = await start.json();
  assert.equal(body.ok, false);
  assert.equal(body.code, "TASK_EXPIRED");
  assert.equal(body.status, "expired");
  assert.equal("task" in body, false);
});
