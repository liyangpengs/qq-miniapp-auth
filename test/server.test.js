import test from "node:test";
import assert from "node:assert/strict";

process.env.HOST = "127.0.0.1";
process.env.BRIDGE_URL = "";

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

  const start = await fetch(`${base}/api/miniapp/start`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ appId: "wx_123" })
  });
  assert.equal(start.status, 409);
  const body = await start.json();
  assert.equal(body.code, "WORKFLOW_REQUIRED");
});
