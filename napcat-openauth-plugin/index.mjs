import fs from "node:fs";

function readConfig(ctx) {
  try {
    const parsed = JSON.parse(fs.readFileSync(ctx.configPath, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function safeValue(value, seen = new WeakSet(), depth = 0) {
  if (value === null || value === undefined) return value;
  if (["string", "number", "boolean"].includes(typeof value)) return value;
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "function") return "[function]";
  if (depth > 8) return "[max depth]";
  if (typeof value !== "object") return String(value);
  if (seen.has(value)) return "[circular]";
  seen.add(value);
  if (Array.isArray(value)) return value.slice(0, 200).map((item) => safeValue(item, seen, depth + 1));
  const result = {};
  for (const key of Object.keys(value).slice(0, 200)) {
    try { result[key] = safeValue(value[key], seen, depth + 1); } catch { result[key] = "[unreadable]"; }
  }
  return result;
}

function extractCode(value) {
  if (typeof value === "string") return value.trim();
  if (!value || typeof value !== "object") return "";
  const direct = String(value.code || value.openCode || value.authCode || value.auth_code ||
    value.accessToken || value.token || value.openAuthCode || "").trim();
  if (direct) return direct;
  for (const key of ["result", "data", "value"]) {
    const nested = extractCode(value[key]);
    if (nested) return nested;
  }
  return "";
}

function getResultCode(value) {
  if (!value || typeof value !== "object") return 0;
  const resultCode = Number(value.errCode ?? value.errorCode ?? 0);
  return Number.isFinite(resultCode) ? resultCode : 0;
}

// QQ 9.9.x exposes the qq.login authorization value as the `result` of
// loginWithAppId, rather than under a field named `code`. Restrict this
// interpretation to that method and a successful errCode so arbitrary data
// from the other NodeMiscService methods is never presented as a code.
function extractOperationCode(operation, value) {
  if (operation === "loginWithAppId") {
    if (getResultCode(value) !== 0) return "";
    return extractCode(value?.result);
  }
  return extractCode(value);
}

function extractOpenId(value) {
  if (!value || typeof value !== "object") return "";
  return String(value.openId || value.openID || value.openid || "").trim();
}

function getMiscService(ctx) {
  return ctx?.core?.context?.session?.getNodeMiscService?.();
}

function getLoginService(ctx) {
  try {
    return ctx?.core?.context?.wrapper?.NodeIKernelLoginService?.get?.();
  } catch {
    return undefined;
  }
}

export async function plugin_init(ctx) {
  const config = readConfig(ctx);
  const configuredToken = String(config.token || "").trim();
  const checkToken = (req, res) => {
    if (!configuredToken) return true;
    const authorization = Array.isArray(req.headers.authorization) ? req.headers.authorization[0] : req.headers.authorization;
    if (authorization === `Bearer ${configuredToken}`) return true;
    res.status(401).json({ ok: false, error: "Unauthorized" });
    return false;
  };

  ctx.router.getNoAuth("/status", async (req, res) => {
    if (!checkToken(req, res)) return;
    const service = getMiscService(ctx);
    const loginService = getLoginService(ctx);
    res.json({
      ok: true,
      ready: Boolean(service),
      logoutAvailable: typeof loginService?.offline === "function",
      methods: service ? ["getOpenAuth", "getOpenCodeWithAppId", "loginWithAppId", "checkSessionForMiniApp", "loginWXMiniApp", "getUserInfoWithAppId"].filter((name) => typeof service[name] === "function") : []
    });
  });

  ctx.router.postNoAuth("/miniapp", async (req, res) => {
    if (!checkToken(req, res)) return;
    const appId = String(req.body?.appId || "").trim();
    if (!/^\d{6,20}$/.test(appId)) {
      res.status(400).json({ ok: false, error: "appId must contain 6 to 20 digits" });
      return;
    }
    const service = getMiscService(ctx);
    if (!service) {
      res.status(503).json({ ok: false, error: "QQ NodeMiscService is not ready" });
      return;
    }
    const methods = {};
    if (typeof service.getOpenCodeWithAppId === "function") methods.getOpenCodeWithAppId = () => service.getOpenCodeWithAppId(appId);
    if (typeof service.getOpenAuth === "function") methods.getOpenAuth = (interactive) => service.getOpenAuth(interactive, appId);
    if (typeof service.loginWithAppId === "function") methods.loginWithAppId = () => service.loginWithAppId(appId);
    if (typeof service.loginWXMiniApp === "function") methods.loginWXMiniApp = () => service.loginWXMiniApp(appId);
    if (typeof service.checkSessionForMiniApp === "function") methods.checkSessionForMiniApp = () => service.checkSessionForMiniApp(appId);
    if (typeof service.getUserInfoWithAppId === "function") methods.getUserInfoWithAppId = () => service.getUserInfoWithAppId(appId);
    if (!Object.keys(methods).length) {
      res.status(503).json({ ok: false, error: "QQ NodeMiscService OpenAuth method is unavailable" });
      return;
    }
    const requestedOperation = String(req.body?.operation || "auto");
    const candidates = requestedOperation === "auto"
      ? ["checkSessionForMiniApp", "loginWithAppId", "getOpenCodeWithAppId", "getOpenAuth"].filter((name) => methods[name])
      : [requestedOperation].filter((name) => methods[name]);
    if (!candidates.length) {
      res.status(400).json({ ok: false, error: `Unsupported OpenAuth operation: ${requestedOperation}`, methods: Object.keys(methods) });
      return;
    }
    let operation = candidates[0];
    let value;
    const attempts = [];
    for (const candidate of candidates) {
      operation = candidate;
      try {
        value = await methods[candidate](req.body?.interactive !== false);
        const safe = safeValue(value);
        attempts.push({ operation: candidate, result: safe });
        if (extractOperationCode(candidate, value)) break;
      } catch (error) {
        attempts.push({ operation: candidate, error: error?.message || String(error) });
      }
    }
    const code = extractOperationCode(operation, value);
    const openId = extractOpenId(value);
    res.json({
      ok: true,
      appId,
      operation,
      method: code ? operation : undefined,
      code: code || undefined,
      openId: openId || undefined,
      result: safeValue(value),
      attempts,
      error: code ? undefined : "QQNT OpenAuth methods returned no authorization code"
    });
  });

  // NodeIKernelLoginService.offline() is NapCat's native QQ account logout
  // operation. It logs the QQ account off without stopping NapCat or QQNT.
  ctx.router.postNoAuth("/logout", async (req, res) => {
    if (!checkToken(req, res)) return;
    const service = getLoginService(ctx);
    if (!service || typeof service.offline !== "function") {
      res.status(503).json({ ok: false, error: "NapCat NodeIKernelLoginService.offline is unavailable" });
      return;
    }
    try {
      const result = await service.offline();
      res.json({ ok: true, loggedOut: true, method: "NodeIKernelLoginService.offline", result: safeValue(result) });
    } catch (error) {
      res.status(502).json({ ok: false, error: error?.message || String(error) });
    }
  });

  ctx.logger.info("QQ mini-app OpenAuth plugin loaded");
}
