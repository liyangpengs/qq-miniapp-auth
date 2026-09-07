import http from "node:http";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

dotenv.config();

const config = {
  host: process.env.BRIDGE_HOST || "127.0.0.1",
  port: numberEnv("BRIDGE_PORT", 9010),
  token: process.env.BRIDGE_TOKEN || "",
  napcatApiUrl: trimSlash(process.env.NAPCAT_API_URL || "http://127.0.0.1:3000"),
  napcatToken: process.env.NAPCAT_TOKEN || "",
  napcatPluginUrl: trimSlash(process.env.NAPCAT_OPEN_AUTH_PLUGIN_URL || "http://127.0.0.1:6099/plugin/qq-miniapp-openauth/api"),
  napcatPluginToken: process.env.NAPCAT_OPEN_AUTH_PLUGIN_TOKEN || "",
  napcatTimeoutMs: numberEnv("NAPCAT_OPEN_AUTH_TIMEOUT_MS", 45_000),
  ttlMs: numberEnv("BRIDGE_TASK_TTL_MS", 2 * 60 * 1000)
};

const sessions = new Map();

function numberEnv(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function trimSlash(value) { return value.replace(/\/+$/, ""); }

function validAppId(appId) {
  return typeof appId === "string" && /^[A-Za-z0-9_-]{3,128}$/.test(appId);
}

function makeId() { return crypto.randomBytes(18).toString("hex"); }

function scheduleSessionExpiry(session) {
  const delay = Math.max(1, session.expiresAt - Date.now() + 5);
  session.expirationTimer = setTimeout(() => {
    if (session.status === "pending") {
      session.status = "expired";
      session.error = "授权任务已超过 2 分钟，已自动取消";
    }
  }, delay);
  session.expirationTimer.unref?.();
}

function sendJson(response, status, payload) {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": "*"
  });
  response.end(body);
}

async function requestJson(url, { method = "GET", body, timeoutMs = config.napcatTimeoutMs, headers: extraHeaders } = {}) {
  const headers = { Accept: "application/json", ...(extraHeaders || {}) };
  if (config.napcatToken && !headers.Authorization) headers.Authorization = `Bearer ${config.napcatToken}`;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  let response;
  try {
    response = await fetch(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs)
    });
  } catch (error) {
    const networkCode = error?.cause?.code || error?.cause?.cause?.code;
    const reason = error?.name === "TimeoutError" || error?.name === "AbortError"
      ? `timeout after ${timeoutMs}ms`
      : [networkCode, error?.message || "network error"].filter(Boolean).join(": ");
    const wrapped = new Error(`NapCat request failed (${new URL(url).host}): ${reason}`);
    wrapped.status = 502;
    wrapped.cause = error;
    throw wrapped;
  }
  const raw = await response.text();
  let payload;
  try { payload = raw ? JSON.parse(raw) : {}; } catch { payload = { raw }; }
  if (!response.ok) {
    const error = new Error(`NapCat returned HTTP ${response.status}`);
    error.status = 502;
    error.payload = payload;
    throw error;
  }
  return payload;
}

function napcatError(payload, fallback) {
  if (!payload || typeof payload !== "object") return null;
  const retcode = Number(payload.retcode);
  if (Number.isFinite(retcode) && retcode !== 0) {
    const error = new Error(payload.message || payload.wording || fallback);
    error.status = 502;
    error.payload = payload;
    return error;
  }
  return null;
}

async function napcatCall(action, body = {}, options = {}) {
  const payload = await requestJson(`${config.napcatApiUrl}/${action}`, { method: "POST", body, ...options });
  const error = napcatError(payload, `NapCat action ${action} failed`);
  if (error) throw error;
  return payload;
}

function extractLoginProfile(payload) {
  const data = payload?.data && typeof payload.data === "object" ? payload.data : payload;
  return {
    uin: String(data?.user_id || data?.uin || data?.qq || "").trim(),
    nickname: String(data?.nickname || data?.nick || "").trim()
  };
}

function extractOpenAuthCode(payload) {
  const outer = payload?.data?.result ?? payload?.result ?? payload?.data ?? payload ?? {};
  const inner = outer && typeof outer === "object" && "result" in outer ? outer.result : outer;
  let code = "";
  // Prefer an explicit code exposed by the provider. The NapCat plugin uses
  // this for loginWithAppId because QQNT returns the authorization value in a
  // method-specific `result` field.
  if (typeof payload?.code === "string") {
    code = payload.code.trim();
  } else if (typeof payload?.authorizationCode === "string") {
    code = payload.authorizationCode.trim();
  } else if (typeof payload?.authorization?.code === "string") {
    code = payload.authorization.code.trim();
  } else if (typeof inner === "string") {
    code = inner.trim();
  } else if (inner && typeof inner === "object") {
    code = String(
      inner.code || inner.authorizationCode || inner.authorization_code || inner.openCode || inner.authCode || inner.auth_code ||
      inner.accessToken || inner.token || inner.openAuthCode || ""
    ).trim();
  }
  const source = inner && typeof inner === "object" ? inner : outer;
  const openId = String(source?.openId || source?.openID || source?.openid || "").trim();
  const resultCode = Number(
    source?.errorCode ?? source?.errCode ?? outer?.errorCode ?? outer?.errCode ??
    payload?.errorCode ?? payload?.errCode ?? 0
  );
  return {
    code,
    openId,
    resultCode: Number.isFinite(resultCode) ? resultCode : 0,
    raw: payload
  };
}

async function napcatPluginCall(appId) {
  if (!config.napcatPluginUrl) {
    const error = new Error("NapCat OpenAuth plugin URL is not configured");
    error.status = 503;
    throw error;
  }
  const headers = {};
  if (config.napcatPluginToken) headers.Authorization = `Bearer ${config.napcatPluginToken}`;
  const payload = await requestJson(`${config.napcatPluginUrl}/miniapp`, {
    method: "POST",
    body: { appId, interactive: true },
    headers,
    timeoutMs: config.napcatTimeoutMs
  });
  if (payload?.ok === false) {
    const error = new Error(payload.error || payload.message || "NapCat OpenAuth plugin failed");
    error.status = 502;
    error.payload = payload;
    throw error;
  }
  const result = extractOpenAuthCode(payload);
  if (result.resultCode === 0 && result.code) {
    return { ...result, operation: "plugin", action: "napcat-plugin:qq-miniapp-openauth" };
  }
  throw formatActionFailure("NapCat OpenAuth plugin", "/miniapp", payload);
}

async function napcatPluginLogout() {
  if (!config.napcatPluginUrl) {
    const error = new Error("NapCat OpenAuth plugin URL is not configured");
    error.status = 503;
    throw error;
  }
  const headers = {};
  if (config.napcatPluginToken) headers.Authorization = `Bearer ${config.napcatPluginToken}`;
  const payload = await requestJson(`${config.napcatPluginUrl}/logout`, {
    method: "POST",
    body: {},
    headers,
    timeoutMs: 15_000
  });
  if (payload?.ok !== true || payload?.loggedOut !== true) {
    const error = new Error(payload?.error || "NapCat logout did not complete");
    error.status = 502;
    error.payload = payload;
    throw error;
  }
  return payload;
}

function formatActionFailure(action, pathName, payload) {
  let raw = "";
  try {
    raw = JSON.stringify({
      retcode: payload?.retcode,
      status: payload?.status,
      message: payload?.message ?? payload?.wording ?? "",
      data: payload?.data
    }).slice(0, 500);
  } catch {
    raw = String(payload).slice(0, 500);
  }
  const error = new Error(`NapCat ${action} (${pathName}) returned no usable Code (raw: ${raw})`);
  error.status = 502;
  error.payload = payload;
  return error;
}

async function invokeOpenAuth(appId) {
  return napcatPluginCall(appId);
}

function createMiniappSession(appId) {
  if (!validAppId(appId)) {
    const error = new Error("appId must be 3-128 ASCII letters, numbers, '_' or '-'");
    error.status = 400;
    throw error;
  }
  const session = {
    id: makeId(),
    appId,
    status: "pending",
    createdAt: Date.now(),
    expiresAt: Date.now() + config.ttlMs,
    code: undefined,
    openId: undefined,
    uin: undefined,
    nickname: undefined,
    action: undefined,
    cancelled: false,
    error: undefined
  };
  sessions.set(session.id, session);
  scheduleSessionExpiry(session);
  // OpenAuth can take several seconds. Keep the HTTP start request fast and
  // let the status endpoint observe the result.
  void authorizeMiniappSession(session);
  return session;
}

async function authorizeMiniappSession(session) {
  if (session.status !== "pending") return session;
  if (Date.now() >= session.expiresAt) {
    session.status = "expired";
    session.error = "授权任务已过期";
    return session;
  }
  try {
    const profilePayload = await napcatCall("get_login_info", {}, { timeoutMs: 15_000 });
    const profile = extractLoginProfile(profilePayload);
    if (!profile.uin) {
      const error = new Error("NapCat 当前未登录 QQ，请先完成上方 QQ 扫码登录");
      error.status = 409;
      throw error;
    }
    const authorization = await invokeOpenAuth(session.appId);
    if (session.status !== "pending") return session;
    if (Date.now() >= session.expiresAt) {
      session.status = "expired";
      session.error = "授权任务已过期";
      return session;
    }
    session.code = authorization.code;
    session.openId = authorization.openId || undefined;
    session.uin = profile.uin;
    session.nickname = profile.nickname || undefined;
    session.action = authorization.action;
    session.status = "success";
    if (session.expirationTimer) clearTimeout(session.expirationTimer);
    return session;
  } catch (error) {
    if (Date.now() >= session.expiresAt) {
      session.status = "expired";
      session.error = "授权任务已过期";
    } else {
      session.status = error.status === 409 ? "login_required" : "failed";
      session.error = error.message;
    }
    return session;
  }
}

function publicSession(session) {
  return {
    id: session.id,
    appId: session.appId,
    status: session.status,
    code: session.code,
    openId: session.openId,
    uin: session.uin,
    nickname: session.nickname,
    error: session.error,
    cancelled: Boolean(session.cancelled),
    expiresAt: session.expiresAt
  };
}

async function parseBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 1024 * 1024) throw Object.assign(new Error("Request body too large"), { status: 413 });
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw Object.assign(new Error("Request body must be valid JSON"), { status: 400 }); }
}

async function route(request, response) {
  const url = new URL(request.url, `http://${request.headers.host || "localhost"}`);
  try {
    if (request.method === "OPTIONS") {
      response.writeHead(204, { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "Content-Type,Authorization", "Access-Control-Allow-Methods": "GET,POST,OPTIONS" });
      response.end();
      return;
    }
    if (url.pathname === "/health" && request.method === "GET") {
      sendJson(response, 200, {
        ok: true,
        provider: "napcat-openauth-plugin",
        napcatApiUrl: config.napcatApiUrl,
        napcatPluginUrl: config.napcatPluginUrl,
        napcatPluginConfigured: Boolean(config.napcatPluginUrl),
        activeTasks: sessions.size
      });
      return;
    }
    if (config.token && request.headers.authorization !== `Bearer ${config.token}`) {
      sendJson(response, 401, { ok: false, error: "Unauthorized" });
      return;
    }
    if (url.pathname === "/api/miniapp/login/start" && request.method === "POST") {
      const body = await parseBody(request);
      const session = createMiniappSession(body.appId);
      sendJson(response, 200, { ok: true, taskId: session.id, status: session.status, appId: session.appId, expiresAt: session.expiresAt });
      return;
    }
    if (url.pathname === "/api/qq/logout" && request.method === "POST") {
      const result = await napcatPluginLogout();
      sendJson(response, 200, result);
      return;
    }
    const cancelMatch = url.pathname.match(/^\/api\/miniapp\/login\/cancel\/([^/]+)$/);
    if (cancelMatch && request.method === "POST") {
      const session = sessions.get(cancelMatch[1]);
      if (!session) return sendJson(response, 404, { ok: false, error: "Mini-app login task not found" });
      if (["pending", "login_required"].includes(session.status)) {
        session.status = "cancelled";
        session.cancelled = true;
        session.error = "任务已取消";
        if (session.expirationTimer) clearTimeout(session.expirationTimer);
      }
      sendJson(response, 200, { ok: true, ...publicSession(session), cancelled: true });
      return;
    }
    const match = url.pathname.match(/^\/api\/miniapp\/login\/status\/([^/]+)$/);
    if (match && request.method === "GET") {
      const session = sessions.get(match[1]);
      if (!session) return sendJson(response, 404, { ok: false, error: "Mini-app login task not found" });
      if (session.status === "pending" && Date.now() >= session.expiresAt) {
        session.status = "expired";
        session.error = "授权任务已过期";
      }
      sendJson(response, 200, { ok: true, ...publicSession(session) });
      return;
    }
    sendJson(response, 404, { ok: false, error: "Not found" });
  } catch (error) {
    sendJson(response, Number.isInteger(error.status) ? error.status : 502, { ok: false, error: error.message, details: error.payload });
  }
}

export function createBridgeServer() {
  return http.createServer((request, response) => { route(request, response); });
}

export function listenBridgeServer(server, callback) {
  server.listen(config.port, config.host, callback);
  return server;
}

const cleanupTimer = setInterval(() => {
  const cutoff = Date.now() - config.ttlMs - 60_000;
  for (const [id, session] of sessions) {
    if (session.createdAt < cutoff) {
      if (session.expirationTimer) clearTimeout(session.expirationTimer);
      sessions.delete(id);
    }
  }
}, 60_000);
cleanupTimer.unref();

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const server = listenBridgeServer(createBridgeServer(), () => {
    console.log(`NapCat OpenAuth bridge listening at http://${config.host}:${config.port}`);
    console.log(`NapCat OneBot API: ${config.napcatApiUrl}`);
  });
  process.on("SIGINT", () => server.close(() => process.exit(0)));
  process.on("SIGTERM", () => server.close(() => process.exit(0)));
}

export { config, validAppId, createMiniappSession, authorizeMiniappSession, publicSession, extractOpenAuthCode };
