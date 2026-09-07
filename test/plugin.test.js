import test from "node:test";
import assert from "node:assert/strict";
import { plugin_init } from "../napcat-openauth-plugin/index.mjs";

function responseStub() {
  return {
    statusCode: 200,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; }
  };
}

test("NapCat plugin uses loginWithAppId result as the real authorization code", async () => {
  const routes = {};
  const service = {
    checkSessionForMiniApp: async (appId) => ({ errCode: 0, appId }),
    loginWithAppId: async (appId) => ({ errCode: 0, errMsg: "", result: `real-code-${appId}` }),
    getOpenCodeWithAppId: async () => ({ errCode: -101227001, result: "" }),
    getOpenAuth: async () => ({ errorCode: 110201, accessToken: "" })
  };
  await plugin_init({
    configPath: "Z:\\qq-miniapp-auth-test-config.json",
    core: { context: { session: { getNodeMiscService: () => service } } },
    router: {
      getNoAuth(path, handler) { routes[`GET ${path}`] = handler; },
      postNoAuth(path, handler) { routes[`POST ${path}`] = handler; }
    },
    logger: { info() {} }
  });

  const response = responseStub();
  await routes["POST /miniapp"]({ body: { appId: "1112386029" }, headers: {} }, response);

  assert.equal(response.statusCode, 200);
  assert.equal(response.body.ok, true);
  assert.equal(response.body.operation, "loginWithAppId");
  assert.equal(response.body.method, "loginWithAppId");
  assert.equal(response.body.code, "real-code-1112386029");
  assert.deepEqual(response.body.attempts.map((attempt) => attempt.operation), [
    "checkSessionForMiniApp",
    "loginWithAppId"
  ]);
});

test("NapCat plugin logs the QQ account out through the native login service", async () => {
  const routes = {};
  let offlineCalls = 0;
  await plugin_init({
    configPath: "Z:\\qq-miniapp-auth-test-config.json",
    core: {
      context: {
        session: { getNodeMiscService: () => ({}) },
        wrapper: { NodeIKernelLoginService: { get: () => ({ offline: async () => { offlineCalls += 1; return null; } }) } }
      }
    },
    router: { getNoAuth(path, handler) { routes[`GET ${path}`] = handler; }, postNoAuth(path, handler) { routes[`POST ${path}`] = handler; } },
    logger: { info() {} }
  });
  const response = responseStub();
  await routes["POST /logout"]({ body: {}, headers: {} }, response);
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.loggedOut, true);
  assert.equal(response.body.method, "NodeIKernelLoginService.offline");
  assert.equal(offlineCalls, 1);
});

test("NapCat plugin falls back to the native wrapper session logout", async () => {
  const routes = {};
  let sessionArg;
  await plugin_init({
    configPath: "Z:\\qq-miniapp-auth-test-config.json",
    core: {
      dataPath: "C:\\NapCat\\data",
      selfInfo: { uin: "123456", uid: "u-123456" },
      context: {
        session: {
          getNodeMiscService: () => ({}),
          offLine: async (value) => {
            sessionArg = value;
            return { result: 0, errMsg: "success" };
          }
        },
        basicInfoWrapper: {
          getFullQQVersion: () => "9.9.33",
          QQVersionAppid: "16"
        }
      }
    },
    router: { getNoAuth(path, handler) { routes[`GET ${path}`] = handler; }, postNoAuth(path, handler) { routes[`POST ${path}`] = handler; } },
    logger: { info() {} }
  });
  const response = responseStub();
  await routes["POST /logout"]({ body: {}, headers: {} }, response);
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.loggedOut, true);
  assert.equal(response.body.method, "WrapperSession.offLine");
  assert.equal(sessionArg.selfUin, "123456");
  assert.equal(sessionArg.selfUid, "u-123456");
  assert.equal(sessionArg.desktopPathConfig.account_path, "C:\\NapCat\\data");
});
