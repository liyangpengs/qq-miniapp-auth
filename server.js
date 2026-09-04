import http from "node:http";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import QRCode from "qrcode";

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, "public");
const tasks = new Map();
const visitorSessions = new Map();
let activeWorkflow = null;
let logoutRecoveryRequired = false;
let logoutRecoveryPromise = null;

const config = {
  port: numberEnv("PORT", 8787),
  host: process.env.HOST || "127.0.0.1",
  napcatApiUrl: trimSlash(process.env.NAPCAT_API_URL || "http://127.0.0.1:3000"),
  napcatToken: process.env.NAPCAT_TOKEN || "",
  napcatWebUiApiUrl: trimSlash(process.env.NAPCAT_WEBUI_API_URL || "http://127.0.0.1:6099/api"),
  napcatWebUiConfig: process.env.NAPCAT_WEBUI_CONFIG || "",
  napcatWebUiToken: process.env.NAPCAT_WEBUI_TOKEN || "",
  napcatWebUiCredential: process.env.NAPCAT_WEBUI_CREDENTIAL || "",
  napcatQrImagePath: process.env.NAPCAT_QR_IMAGE_PATH || "",
  bridgeUrl: trimSlash(process.env.BRIDGE_URL || ""),
  bridgeToken: process.env.BRIDGE_TOKEN || "",
  bridgeMiniStartPath: process.env.BRIDGE_MINIAPP_START_PATH || "/api/miniapp/login/start",
  bridgeMiniStatusPath: process.env.BRIDGE_MINIAPP_STATUS_PATH || "/api/miniapp/login/status",
  bridgeLogoutPath: process.env.BRIDGE_LOGOUT_PATH || "/api/qq/logout",
  workflowTtlMs: numberEnv("WORKFLOW_TTL_MS", 10 * 60 * 1000),
  sessionTtlMs: numberEnv("SESSION_TTL_MS", 24 * 60 * 60 * 1000),
  sessionCookieName: process.env.SESSION_COOKIE_NAME || "qqma_session",
  sessionCookieSameSite: ["Strict", "Lax", "None"].includes(process.env.SESSION_COOKIE_SAMESITE) ? process.env.SESSION_COOKIE_SAMESITE : "Lax",
  sessionCookieSecure: /^(1|true|yes|on)$/i.test(String(process.env.SESSION_COOKIE_SECURE || "0")),
  corsOrigin: process.env.CORS_ORIGIN || "same-origin",
  miniappSecrets: parseSecrets(process.env.MINIAPP_SECRETS || "{}")
};

let webUiCredential = config.napcatWebUiCredential;
let loginStartPromise = null;
let loginStartOwnerSessionId = "";

function numberEnv(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function trimSlash(value) {
  return value.replace(/\/+$/, "");
}

function parseSecrets(value) {
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function webUiConfigCandidates() {
  const candidates = [];
  const add = (value) => {
    const file = String(value || "").trim();
    if (file && !candidates.includes(file)) candidates.push(file);
  };
  add(config.napcatWebUiConfig);
  add(process.env.NAPCAT_WEBUI_CONFIG);
  const appData = process.env.APPDATA;
  const localAppData = process.env.LOCALAPPDATA;
  for (const root of [appData, localAppData]) {
    add(root && path.join(root, "NapCat", "config", "webui.json"));
    add(root && path.join(root, "Tencent", "QQ", "NapCat", "config", "webui.json"));
  }
  add(path.join(os.homedir(), ".config", "napcat", "webui.json"));
  add(path.join(__dirname, "config", "webui.json"));
  return candidates;
}

function discoverWebUiToken() {
  if (config.napcatWebUiToken) return config.napcatWebUiToken;
  for (const file of webUiConfigCandidates()) {
    try {
      const parsed = JSON.parse(fsSync.readFileSync(file, "utf8"));
      const token = String(parsed?.token || parsed?.Token || "").trim();
      if (token) return token;
    } catch {
      // The file is optional; continue to the next known NapCat location.
    }
  }
  return "";
}

function qrImageCandidates() {
  const candidates = [];
  const add = (value) => {
    const file = String(value || "").trim();
    if (file && !candidates.includes(file)) candidates.push(file);
  };
  add(config.napcatQrImagePath);
  const workdir = process.env.NAPCAT_WORKDIR;
  add(workdir && path.join(workdir, "cache", "qrcode.png"));
  for (const root of [process.env.APPDATA, process.env.LOCALAPPDATA]) {
    add(root && path.join(root, "NapCat", "cache", "qrcode.png"));
    add(root && path.join(root, "Tencent", "QQ", "NapCat", "cache", "qrcode.png"));
  }
  return candidates;
}

function readNapcatQrImage() {
  for (const file of qrImageCandidates()) {
    try {
      const stat = fsSync.statSync(file);
      if (!stat.isFile() || stat.size < 1 || stat.size > 8 * 1024 * 1024) continue;
      const image = fsSync.readFileSync(file);
      if (image.length > 0) return `data:image/png;base64,${image.toString("base64")}`;
    } catch {
      // NapCat may not have written a QR yet; try the next configured location.
    }
  }
  return undefined;
}

function hasLoggedInUser(user) {
  const id = user?.user_id ?? user?.uin ?? user?.qq ?? user?.id;
  return id !== undefined && id !== null && String(id).trim() !== "" && String(id) !== "0";
}

function makeId() {
  return crypto.randomBytes(18).toString("hex");
}

function parseCookies(request) {
  const header = String(request.headers.cookie || "");
  const cookies = {};
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index <= 0) continue;
    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (key) {
      try { cookies[key] = decodeURIComponent(value); } catch { cookies[key] = value; }
    }
  }
  return cookies;
}

function createVisitorSession() {
  const session = { id: makeId(), createdAt: Date.now(), lastSeenAt: Date.now() };
  visitorSessions.set(session.id, session);
  return session;
}

function ensureVisitorSession(request, response) {
  const cookieName = config.sessionCookieName;
  const existingId = parseCookies(request)[cookieName];
  const existing = existingId && visitorSessions.get(existingId);
  if (existing && Date.now() - existing.lastSeenAt < config.sessionTtlMs) {
    existing.lastSeenAt = Date.now();
    return { ...existing, fromCookie: true };
  }
  const session = createVisitorSession();
  const attributes = [
    `${cookieName}=${encodeURIComponent(session.id)}`,
    "Path=/",
    `Max-Age=${Math.floor(config.sessionTtlMs / 1000)}`,
    "HttpOnly",
    `SameSite=${config.sessionCookieSameSite}`
  ];
  if (config.sessionCookieSecure) attributes.push("Secure");
  response.setHeader("Set-Cookie", attributes.join("; "));
  return { ...session, fromCookie: false };
}

function createTask(kind, values = {}, ownerSessionId) {
  const task = {
    id: makeId(),
    kind,
    status: "pending",
    createdAt: Date.now(),
    expiresAt: Date.now() + 5 * 60 * 1000,
    ownerSessionId,
    ...values
  };
  tasks.set(task.id, task);
  return task;
}

function makeWorkflowBusyError(workflow = activeWorkflow) {
  const error = new Error("当前已有其他用户占用 NapCat，请等待其完成登录和取码后再试");
  error.status = 409;
  error.code = "WORKFLOW_BUSY";
  error.payload = {
    phase: workflow?.phase || "unknown",
    expiresAt: workflow?.expiresAt,
    retryAfterMs: workflow?.expiresAt ? Math.max(0, workflow.expiresAt - Date.now()) : undefined
  };
  return error;
}

function expireWorkflowIfNeeded() {
  if (activeWorkflow && activeWorkflow.expiresAt <= Date.now()) {
    activeWorkflow = null;
  }
  return activeWorkflow;
}

function acquireWorkflow(ownerSessionId) {
  const current = expireWorkflowIfNeeded();
  if (current && current.ownerSessionId !== ownerSessionId) throw makeWorkflowBusyError(current);
  if (!current) {
    activeWorkflow = {
      ownerSessionId,
      phase: "login",
      acquiredAt: Date.now(),
      expiresAt: Date.now() + config.workflowTtlMs,
      loginTaskId: "",
      miniappTaskId: ""
    };
  }
  return activeWorkflow;
}

function requireWorkflowOwner(ownerSessionId) {
  const current = expireWorkflowIfNeeded();
  if (!current) {
    const error = new Error("请先创建 QQ 扫码登录任务");
    error.status = 409;
    error.code = "WORKFLOW_REQUIRED";
    throw error;
  }
  if (current.ownerSessionId !== ownerSessionId) throw makeWorkflowBusyError(current);
  current.expiresAt = Date.now() + config.workflowTtlMs;
  return current;
}

function releaseWorkflow(ownerSessionId) {
  if (!activeWorkflow || (ownerSessionId && activeWorkflow.ownerSessionId !== ownerSessionId)) return;
  activeWorkflow = null;
}

function publicTask(task) {
  if (!task) return null;
  return {
    id: task.id,
    kind: task.kind,
    appId: task.appId,
    status: task.status,
    mode: task.mode,
    qrUrl: task.qrUrl,
    qrImage: task.qrImage,
    user: task.user,
    code: task.code,
    error: task.error,
    scanned: task.scanned,
    confirmed: task.confirmed,
    cancelled: task.cancelled,
    logoutStatus: task.logoutStatus,
    logoutMethod: task.logoutMethod,
    logoutError: task.logoutError,
    released: task.logoutStatus === "success" || task.released === true,
    state: task.kind === "napcat-login" ? loginState(task) : task.status,
    expiresAt: task.expiresAt
  };
}

function loginState(task) {
  if (!task) return "unknown";
  if (task.status === "success") return "confirmed";
  if (task.status === "scanned") return "scanned";
  if (task.status === "cancelled") return "cancelled";
  if (task.status === "expired") return "expired";
  if (task.status === "failed") return "failed";
  return "waiting_scan";
}

function normalizeBridgeResult(value) {
  if (!value || typeof value !== "object") return {};
  if (value.data && typeof value.data === "object" && !Array.isArray(value.data)) {
    return { ...value, ...value.data };
  }
  return value;
}

function joinUrl(base, requestPath) {
  if (/^https?:\/\//i.test(requestPath)) return requestPath;
  return `${base}${requestPath.startsWith("/") ? "" : "/"}${requestPath}`;
}

async function requestJson(url, { method = "GET", body, token, headers: extraHeaders } = {}) {
  const headers = { Accept: "application/json", ...(extraHeaders || {}) };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await fetch(url, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(12_000)
  });
  const raw = await response.text();
  let payload;
  try {
    payload = raw ? JSON.parse(raw) : {};
  } catch {
    payload = { raw };
  }
  if (!response.ok) {
    const error = new Error(`Upstream returned HTTP ${response.status}`);
    error.status = response.status;
    error.payload = payload;
    throw error;
  }
  return payload;
}

async function napcatCall(action, params = {}) {
  const payload = await requestJson(joinUrl(config.napcatApiUrl, `/${action}`), {
    method: "POST",
    body: params,
    token: config.napcatToken
  });
  if (payload && typeof payload === "object" && payload.retcode !== undefined && payload.retcode !== 0) {
    const error = new Error(payload.message || payload.wording || `NapCat retcode ${payload.retcode}`);
    error.status = 502;
    error.payload = payload;
    throw error;
  }
  return payload?.data ?? payload;
}

function isWebUiConfigured() {
  return Boolean(config.napcatWebUiApiUrl && (webUiCredential || discoverWebUiToken()));
}

async function ensureWebUiCredential() {
  if (webUiCredential) return webUiCredential;
  const webUiToken = discoverWebUiToken();
  if (!webUiToken) {
    throw new Error("NapCat WebUI token not found. Set NAPCAT_WEBUI_TOKEN or NAPCAT_WEBUI_CONFIG to config/webui.json");
  }
  const hash = crypto.createHash("sha256").update(`${webUiToken}.napcat`, "utf8").digest("hex");
  const payload = await requestJson(joinUrl(config.napcatWebUiApiUrl, "/auth/login"), {
    method: "POST",
    body: { hash }
  });
  if (payload?.code !== undefined && payload.code !== 0) {
    const error = new Error(payload.message || "NapCat WebUI login failed");
    error.status = 502;
    error.payload = payload;
    throw error;
  }
  webUiCredential = payload?.data?.Credential;
  if (!webUiCredential) {
    const error = new Error("NapCat WebUI did not return a credential (2FA may be enabled)");
    error.status = 502;
    throw error;
  }
  return webUiCredential;
}

async function webUiCall(action, params = {}) {
  let lastError;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const credential = await ensureWebUiCredential();
      const payload = await requestJson(joinUrl(config.napcatWebUiApiUrl, action), {
        method: "POST",
        body: params,
        token: credential
      });
      if (payload?.code !== undefined && payload.code !== 0) {
        const error = new Error(payload.message || "NapCat WebUI request failed");
        error.status = 502;
        error.payload = payload;
        throw error;
      }
      return payload?.data ?? payload;
    } catch (error) {
      lastError = error;
      const unauthorized = /unauthorized|credential|凭证|认证/i.test(`${error.message} ${error.payload?.message || ""}`);
      if (attempt === 0 && unauthorized && (config.napcatWebUiToken || discoverWebUiToken())) {
        // NapCat invalidates an old credential when WebUI auth is repeated or
        // after a token refresh. Drop the cache and authenticate once again.
        webUiCredential = "";
        continue;
      }
      throw error;
    }
  }
  throw lastError || new Error("NapCat WebUI request failed");
}

async function bridgeCall(requestPath, options = {}) {
  if (!config.bridgeUrl) throw new Error("BRIDGE_URL is not configured");
  return normalizeBridgeResult(await requestJson(joinUrl(config.bridgeUrl, requestPath), {
    ...options,
    token: config.bridgeToken
  }));
}

function pickQrValue(result) {
  if (typeof result === "string") return result;
  if (!result || typeof result !== "object") return undefined;
  return result.qrcode || result.qrCode || result.qrUrl || result.qr_url ||
    result.image || result.imageUrl || result.image_url || result.base64;
}

async function makeQrImage(value) {
  if (typeof value !== "string" || !value.trim()) return undefined;
  const qr = value.trim();
  if (/^data:image\//i.test(qr)) return qr;
  if (/^[A-Za-z0-9+/]+={0,2}$/.test(qr) && qr.length > 128) return `data:image/png;base64,${qr}`;
  return QRCode.toDataURL(qr, { margin: 1, width: 280 });
}

function createLoginTask(ownerSessionId, values = {}) {
  const task = createTask("napcat-login", values, ownerSessionId);
  if (activeWorkflow && activeWorkflow.ownerSessionId === ownerSessionId) {
    activeWorkflow.loginTaskId = task.id;
    activeWorkflow.phase = task.status === "success" ? "awaiting_code" : "login";
    activeWorkflow.expiresAt = Math.max(activeWorkflow.expiresAt, task.expiresAt);
  }
  return task;
}

async function loginStart(ownerSessionId) {
  const current = expireWorkflowIfNeeded();
  if (current && current.ownerSessionId !== ownerSessionId) throw makeWorkflowBusyError(current);
  if (current?.loginTaskId) {
    const task = tasks.get(current.loginTaskId);
    if (task && task.expiresAt > Date.now() && ["pending", "scanned", "success"].includes(task.status)) return task;
    if (task && ["cancelled", "expired", "failed"].includes(task.status)) releaseWorkflow(ownerSessionId);
  }
  if (loginStartPromise) {
    if (loginStartOwnerSessionId !== ownerSessionId) throw makeWorkflowBusyError(activeWorkflow);
    return loginStartPromise;
  }
  await ensureLogoutRecovery();
  acquireWorkflow(ownerSessionId);
  const operation = loginStartInternal(ownerSessionId);
  loginStartPromise = operation;
  loginStartOwnerSessionId = ownerSessionId;
  try {
    return await operation;
  } catch (error) {
    releaseWorkflow(ownerSessionId);
    throw error;
  } finally {
    if (loginStartPromise === operation) {
      loginStartPromise = null;
      loginStartOwnerSessionId = "";
    }
  }
}

async function loginStartInternal(ownerSessionId) {
  if (!isWebUiConfigured()) {
    const qrImage = readNapcatQrImage();
    if (qrImage) {
      const task = createLoginTask(ownerSessionId, { mode: "napcat-file", qrImage });
      try {
        const user = await napcatCall("get_login_info");
        if (hasLoggedInUser(user)) {
          task.status = "success";
          task.user = user;
        }
      } catch {
        // NapCat is expected to reject get_login_info while waiting for a scan.
      }
      return task;
    }
    try {
      const user = await napcatCall("get_login_info");
      if (hasLoggedInUser(user)) return createLoginTask(ownerSessionId, { mode: "onebot", status: "success", user });
    } catch {
      // Fall through to the actionable configuration error below.
    }
    throw new Error("NapCat QR login is not configured. Set NAPCAT_WEBUI_TOKEN/NAPCAT_WEBUI_CONFIG or NAPCAT_QR_IMAGE_PATH, then retry.");
  }
  try {
    const result = await webUiCall("/QQLogin/GetQQLoginQrcode");
    const qrValue = pickQrValue(result);
    const qrImage = await makeQrImage(qrValue);
    if (!qrImage) throw new Error("NapCat WebUI did not return a usable QR code");
    return createLoginTask(ownerSessionId, {
      mode: "webui-api",
      qrUrl: /^https?:\/\//i.test(String(qrValue || "")) ? qrValue : undefined,
      qrImage
    });
  } catch (error) {
    // 已经登录时 GetQQLoginQrcode 会返回错误，继续读取当前账号。
    try {
      const user = await webUiCall("/QQLogin/GetQQLoginInfo");
      if (hasLoggedInUser(user)) return createLoginTask(ownerSessionId, { mode: "webui-api", status: "success", user });
      throw error;
    } catch {
      throw error;
    }
  }
}

function mapStatus(result) {
  const status = String(result.status || result.state || "pending").toLowerCase();
  if (["ok", "success", "succeeded", "logged_in", "connected"].includes(status)) return "success";
  if (["login_required", "not_logged_in", "unauthenticated"].includes(status)) return "login_required";
  if (["failed", "error", "rejected"].includes(status)) return "failed";
  if (["expired", "timeout", "cancelled", "canceled"].includes(status)) return "expired";
  return "pending";
}

function truthyField(value, names) {
  for (const name of names) {
    if (value?.[name] === true || value?.[name] === 1 || String(value?.[name] || "").toLowerCase() === "true") return true;
  }
  return false;
}

function applyLoginStatus(task, result) {
  const state = String(result?.status || result?.state || "").toLowerCase();
  const message = String(result?.loginError || result?.error || result?.message || "").toLowerCase();
  const cancelled = truthyField(result, ["cancelled", "canceled", "isCancelled", "isCanceled", "userCancelled", "userCanceled"]) ||
    /cancel|取消|拒绝|rejected/.test(`${state} ${message}`);
  const scanned = truthyField(result, ["scanned", "isScanned", "isScan", "scan", "hasScan", "hasScanned", "qrcodeScanned"]) ||
    /scan|已扫|扫码|confirm|确认/.test(`${state} ${message}`);
  const confirmed = truthyField(result, ["confirmed", "isConfirmed", "isConfirm", "confirm", "hasConfirm", "authorized", "isAuthorized"]) || state === "confirmed";
  task.scanned = task.scanned || scanned || confirmed || Boolean(result?.isLogin);
  task.confirmed = task.confirmed || confirmed || Boolean(result?.isLogin) || state === "success" || state === "logged_in";
  task.cancelled = task.cancelled || cancelled;
  task.error = result?.loginError || result?.error || result?.message || task.error;
  if (cancelled) task.status = "cancelled";
  else if (result?.isLogin || state === "success" || state === "logged_in") task.status = "success";
  else if (scanned || confirmed || task.scanned) task.status = "scanned";
  else task.status = "pending";
  return task;
}

async function loginStatus(task) {
  if (task.expiresAt < Date.now() && ["pending", "scanned"].includes(task.status)) task.status = "expired";
  if (["pending", "scanned"].includes(task.status)) {
    try {
      if (task.mode === "webui-api") {
        const result = await webUiCall("/QQLogin/CheckLoginStatus");
        applyLoginStatus(task, result);
        task.user = result?.isLogin ? await webUiCall("/QQLogin/GetQQLoginInfo") : task.user;
        const nextQrValue = result?.qrcodeurl || result?.qrcode || result?.qrUrl || task.qrUrl;
        if (nextQrValue && nextQrValue !== task.qrUrl) {
          task.qrUrl = /^https?:\/\//i.test(String(nextQrValue)) ? nextQrValue : task.qrUrl;
          try { task.qrImage = await makeQrImage(nextQrValue); } catch { /* ignore */ }
        }
        task.error = result?.loginError;
      } else if (task.mode === "napcat-file") {
        task.qrImage = readNapcatQrImage() || task.qrImage;
        const user = await napcatCall("get_login_info");
        if (hasLoggedInUser(user)) {
          task.user = user;
          task.scanned = true;
          task.confirmed = true;
          task.status = "success";
        }
      } else {
        task.user = await napcatCall("get_login_info");
        if (hasLoggedInUser(task.user)) {
          task.scanned = true;
          task.confirmed = true;
          task.status = "success";
        }
      }
    } catch {
      // In WebUI mode an unavailable or not-yet-logged-in NapCat stays pending.
    }
  }
  if (task.id === activeWorkflow?.loginTaskId) {
    if (["cancelled", "expired", "failed"].includes(task.status)) releaseWorkflow(task.ownerSessionId);
    else if (task.status === "success") {
      activeWorkflow.phase = "awaiting_code";
      activeWorkflow.expiresAt = Date.now() + config.workflowTtlMs;
    }
  }
  return task;
}

async function refreshLogin(task) {
  if (!task || task.kind !== "napcat-login") {
    const error = new Error("Login task not found");
    error.status = 404;
    throw error;
  }
  const workflow = acquireWorkflow(task.ownerSessionId);
  workflow.loginTaskId = task.id;
  workflow.miniappTaskId = "";
  workflow.phase = "login";
  workflow.expiresAt = Date.now() + config.workflowTtlMs;
  if (task.mode === "napcat-file") {
    task.qrImage = readNapcatQrImage() || task.qrImage;
    task.status = "pending";
    task.error = undefined;
    task.expiresAt = Date.now() + 5 * 60 * 1000;
    return task;
  }
  if (task.mode !== "webui-api") {
    const error = new Error("This login mode does not expose QR refresh");
    error.status = 400;
    throw error;
  }
  await webUiCall("/QQLogin/RefreshQRcode");
  const result = await webUiCall("/QQLogin/GetQQLoginQrcode");
  const qrValue = pickQrValue(result);
  const qrImage = await makeQrImage(qrValue);
  if (!qrImage) throw new Error("NapCat WebUI did not return a usable QR code");
  task.qrUrl = /^https?:\/\//i.test(String(qrValue || "")) ? qrValue : undefined;
  task.qrImage = qrImage;
  task.status = "pending";
  task.error = undefined;
  task.expiresAt = Date.now() + 5 * 60 * 1000;
  task.scanned = false;
  task.confirmed = false;
  task.cancelled = false;
  if (activeWorkflow?.ownerSessionId === task.ownerSessionId) {
    activeWorkflow.phase = "login";
    activeWorkflow.expiresAt = Date.now() + config.workflowTtlMs;
  }
  return task;
}

function validAppId(appId) {
  return typeof appId === "string" && /^[A-Za-z0-9_-]{3,128}$/.test(appId);
}

async function miniappStart(appId, ownerSessionId) {
  if (!validAppId(appId)) {
    const error = new Error("appId must be 3-128 ASCII letters, numbers, '_' or '-'");
    error.status = 400;
    throw error;
  }
  const workflow = requireWorkflowOwner(ownerSessionId);
  const loginTask = workflow.loginTaskId ? tasks.get(workflow.loginTaskId) : undefined;
  if (!loginTask) {
    const error = new Error("请先完成 QQ 扫码登录");
    error.status = 409;
    error.code = "LOGIN_REQUIRED";
    throw error;
  }
  await loginStatus(loginTask);
  if (loginTask.status !== "success") {
    const error = new Error("请先完成 QQ 扫码登录，再获取小程序 code");
    error.status = 409;
    error.code = "LOGIN_REQUIRED";
    throw error;
  }
  if (workflow.miniappTaskId) {
    const existing = tasks.get(workflow.miniappTaskId);
    if (existing && existing.appId === appId && ["pending", "success", "login_required", "failed"].includes(existing.status)) {
      return existing;
    }
  }
  if (workflow.miniappStartPromise) return workflow.miniappStartPromise;
  const operation = startMiniappThroughBridge(appId, ownerSessionId, workflow);
  workflow.miniappStartPromise = operation;
  try {
    return await operation;
  } finally {
    if (workflow.miniappStartPromise === operation) workflow.miniappStartPromise = null;
  }
}

async function startMiniappThroughBridge(appId, ownerSessionId, workflow) {
  workflow.phase = "miniapp";
  workflow.expiresAt = Date.now() + config.workflowTtlMs;
  if (config.bridgeUrl) {
    const result = await bridgeCall(config.bridgeMiniStartPath, {
      method: "POST",
      body: { appId, source: "qq-miniapp-auth" }
    });
    const task = createTask("miniapp-login", {
      mode: "bridge",
      appId,
      upstreamTaskId: result.taskId || result.task_id || result.id,
      status: result.code ? "success" : mapStatus(result),
      code: result.code,
      qrUrl: result.qrUrl || result.qr_url || result.url,
      qrImage: result.qrImage || result.qr_image,
      user: result.user,
      error: result.error || result.message
    }, ownerSessionId);
    workflow.miniappTaskId = task.id;
    workflow.expiresAt = Math.max(workflow.expiresAt, task.expiresAt);
    if (task.status === "success" && !task.code) {
      task.status = "failed";
      task.error = "Bridge reported success without an authorization code";
    }
    if (task.status === "success") await finalizeMiniappTask(task);
    else if (["failed", "expired", "login_required"].includes(task.status)) releaseWorkflow(ownerSessionId);
    return task;
  }
  const error = new Error("No mini-app bridge configured. Start bridge.js or set BRIDGE_URL.");
  error.status = 503;
  throw error;
}

async function requestNapcatLogout(taskId) {
  const result = await bridgeCall(config.bridgeLogoutPath, {
    method: "POST",
    body: { source: "qq-miniapp-auth", taskId }
  });
  if (result?.loggedOut !== true) {
    const error = new Error(result?.error || "NapCat logout did not complete");
    error.payload = result;
    throw error;
  }
  return result;
}

async function ensureLogoutRecovery() {
  if (!logoutRecoveryRequired) return;
  if (!logoutRecoveryPromise) {
    logoutRecoveryPromise = (async () => {
      try {
        await requestNapcatLogout("recovery");
        logoutRecoveryRequired = false;
      } catch (error) {
        const wrapped = new Error(`上一次 QQ 自动注销失败，无法开始下一位用户：${error.message}`);
        wrapped.status = 503;
        wrapped.code = "LOGOUT_REQUIRED";
        wrapped.payload = error.payload;
        throw wrapped;
      } finally {
        logoutRecoveryPromise = null;
      }
    })();
  }
  return logoutRecoveryPromise;
}

async function finalizeMiniappTask(task) {
  if (!task || task.status !== "success" || !task.code) return task;
  if (["success", "failed"].includes(task.logoutStatus)) return task;
  if (task.logoutPromise) return task.logoutPromise;
  task.logoutStatus = "pending";
  task.logoutPromise = (async () => {
    try {
      const result = await requestNapcatLogout(task.id);
      task.logoutStatus = "success";
      task.logoutMethod = result.method || "NodeIKernelLoginService.offline";
      task.released = true;
      logoutRecoveryRequired = false;
    } catch (error) {
      task.logoutStatus = "failed";
      task.logoutError = error.message;
      task.released = true;
      logoutRecoveryRequired = true;
    } finally {
      releaseWorkflow(task.ownerSessionId);
      task.logoutPromise = null;
    }
    return task;
  })();
  return task.logoutPromise;
}

async function miniappStatus(task) {
  if (task.status === "pending" && task.expiresAt < Date.now()) task.status = "expired";
  if (task.status === "pending" && task.mode === "bridge") {
    try {
      const result = await bridgeCall(`${config.bridgeMiniStatusPath}/${encodeURIComponent(task.upstreamTaskId || task.id)}`);
      task.status = result.code ? "success" : mapStatus(result);
      task.code = result.code || task.code;
      task.user = result.user || task.user;
      task.qrUrl = result.qrUrl || result.qr_url || task.qrUrl;
      task.qrImage = result.qrImage || result.qr_image || task.qrImage;
      task.error = result.error || result.message;
    } catch (error) {
      task.error = error.message;
    }
  }
  if (task.status === "success" && !task.code) {
    task.status = "failed";
    task.error = "Bridge reported success without an authorization code";
  }
  if (task.status === "success") await finalizeMiniappTask(task);
  else if (["failed", "expired", "login_required"].includes(task.status)) releaseWorkflow(task.ownerSessionId);
  return task;
}

async function currentUser() {
  try {
    return await napcatCall("get_login_info");
  } catch (onebotError) {
    if (!isWebUiConfigured()) throw onebotError;
    return webUiCall("/QQLogin/GetQQLoginInfo");
  }
}

async function exchangeMiniappCode(body) {
  const { appId, code } = body || {};
  if (!validAppId(appId) || typeof code !== "string" || code.length < 1) {
    const error = new Error("appId and code are required");
    error.status = 400;
    throw error;
  }
  const secret = config.miniappSecrets[appId];
  if (!secret) {
    const error = new Error("No server-side secret configured for this appId");
    error.status = 400;
    throw error;
  }
  const endpoint = new URL("https://api.q.qq.com/sns/jscode2session");
  endpoint.searchParams.set("appid", appId);
  endpoint.searchParams.set("secret", secret);
  endpoint.searchParams.set("js_code", code);
  endpoint.searchParams.set("grant_type", "authorization_code");
  return requestJson(endpoint.toString());
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
  const raw = Buffer.concat(chunks).toString("utf8");
  try {
    return JSON.parse(raw);
  } catch {
    throw Object.assign(new Error("Request body must be valid JSON"), { status: 400 });
  }
}

function sendJson(response, status, payload) {
  const body = JSON.stringify(payload);
  const headers = {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store"
  };
  if (config.corsOrigin && config.corsOrigin !== "same-origin") {
    headers["Access-Control-Allow-Origin"] = config.corsOrigin;
    headers["Access-Control-Allow-Credentials"] = "true";
    headers.Vary = "Origin";
  }
  response.writeHead(status, headers);
  response.end(body);
}

function taskForRequest(taskId, kind, session, strictOwnership) {
  const task = tasks.get(taskId);
  if (!task || task.kind !== kind) {
    const error = new Error(kind === "napcat-login" ? "Login task not found" : "Mini-app task not found");
    error.status = 404;
    throw error;
  }
  if ((strictOwnership || session?.fromCookie) && (!session || !task.ownerSessionId || task.ownerSessionId !== session.id)) {
    const error = new Error("Task does not belong to this browser session");
    error.status = 404;
    throw error;
  }
  return task;
}

function apiTaskPayload(task) {
  const value = publicTask(task);
  return {
    ok: true,
    taskId: task.id,
    status: value.status,
    state: value.state,
    scanned: Boolean(value.scanned),
    confirmed: Boolean(value.confirmed),
    cancelled: Boolean(value.cancelled),
    isScanned: Boolean(value.scanned),
    isConfirmed: Boolean(value.confirmed),
    isCancelled: Boolean(value.cancelled),
    isLogin: value.status === "success",
    qrImage: value.qrImage,
    qrUrl: value.qrUrl,
    qrcode: value.qrUrl || value.qrImage,
    code: value.code,
    logoutStatus: value.logoutStatus,
    logoutMethod: value.logoutMethod,
    logoutError: value.logoutError,
    released: Boolean(value.released),
    error: value.error,
    expiresAt: value.expiresAt,
    task: value
  };
}

async function waitForMiniappTask(task, timeoutMs = 50_000) {
  const deadline = Date.now() + timeoutMs;
  while (task.status === "pending" && Date.now() < deadline) {
    await miniappStatus(task);
    if (task.status !== "pending") break;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  if (task.status === "pending") {
    task.status = "expired";
    task.error = "授权任务等待超时，请重新请求";
  }
  return task;
}

async function serveStatic(response, requestPath) {
  const relative = requestPath === "/" ? "index.html" : requestPath.replace(/^\/+/, "");
  const resolved = path.resolve(publicDir, relative);
  if (!resolved.startsWith(`${publicDir}${path.sep}`)) return false;
  try {
    const content = await fs.readFile(resolved);
    const type = path.extname(resolved) === ".html" ? "text/html; charset=utf-8" :
      path.extname(resolved) === ".css" ? "text/css; charset=utf-8" :
      path.extname(resolved) === ".js" ? "text/javascript; charset=utf-8" : "application/octet-stream";
    response.writeHead(200, { "Content-Type": type, "Cache-Control": "no-cache" });
    response.end(content);
    return true;
  } catch {
    return false;
  }
}

async function route(request, response) {
  const url = new URL(request.url, `http://${request.headers.host || "localhost"}`);
  const method = request.method || "GET";
  const session = url.pathname.startsWith("/api/") && url.pathname !== "/api/health"
    ? ensureVisitorSession(request, response)
    : undefined;
  try {
    if (method === "OPTIONS") {
      const headers = {
        "Access-Control-Allow-Headers": "Content-Type, Authorization",
        "Access-Control-Allow-Methods": "GET,POST,OPTIONS"
      };
      if (config.corsOrigin && config.corsOrigin !== "same-origin") {
        headers["Access-Control-Allow-Origin"] = config.corsOrigin;
        headers["Access-Control-Allow-Credentials"] = "true";
      }
      response.writeHead(204, headers);
      response.end();
      return;
    }
    if (url.pathname === "/api/health" && method === "GET") {
      sendJson(response, 200, {
        ok: true,
        napcatConfigured: Boolean(config.napcatApiUrl),
        webUiConfigured: isWebUiConfigured(),
        qrFileConfigured: Boolean(readNapcatQrImage()),
        bridgeConfigured: Boolean(config.bridgeUrl),
        workflowBusy: Boolean(expireWorkflowIfNeeded()),
        workflowPhase: expireWorkflowIfNeeded()?.phase,
        workflowExpiresAt: expireWorkflowIfNeeded()?.expiresAt,
        logoutRecoveryRequired,
      });
      return;
    }
    if (url.pathname === "/api/user" && method === "GET") {
      if (logoutRecoveryRequired) {
        const error = new Error("上一位用户的 QQ 尚未完成注销，请稍后再试");
        error.status = 503;
        error.code = "LOGOUT_REQUIRED";
        throw error;
      }
      const workflow = expireWorkflowIfNeeded();
      if (workflow && workflow.ownerSessionId !== session.id) throw makeWorkflowBusyError(workflow);
      const user = await currentUser();
      sendJson(response, 200, { ok: true, user });
      return;
    }
    if (url.pathname === "/api/qq/login/qrcode" && ["GET", "POST"].includes(method)) {
      sendJson(response, 200, apiTaskPayload(await loginStart(session.id)));
      return;
    }
    if (url.pathname === "/api/qq/login/status" && ["GET", "POST"].includes(method)) {
      const body = method === "POST" ? await parseBody(request) : {};
      const taskId = url.searchParams.get("taskId") || body.taskId;
      const task = taskForRequest(taskId, "napcat-login", session, true);
      sendJson(response, 200, apiTaskPayload(await loginStatus(task)));
      return;
    }
    const canonicalLoginMatch = url.pathname.match(/^\/api\/qq\/login\/status\/([^/]+)$/);
    if (canonicalLoginMatch && ["GET", "POST"].includes(method)) {
      const task = taskForRequest(canonicalLoginMatch[1], "napcat-login", session, true);
      sendJson(response, 200, apiTaskPayload(await loginStatus(task)));
      return;
    }
    const canonicalLoginRefreshMatch = url.pathname.match(/^\/api\/qq\/login\/refresh\/([^/]+)$/);
    if (canonicalLoginRefreshMatch && method === "POST") {
      const task = taskForRequest(canonicalLoginRefreshMatch[1], "napcat-login", session, true);
      sendJson(response, 200, apiTaskPayload(await refreshLogin(task)));
      return;
    }
    if (url.pathname === "/api/qq/miniapp/code" && method === "POST") {
      const body = await parseBody(request);
      const task = await miniappStart(body.appId, session.id);
      if (body.wait === true || body.wait === "true") await waitForMiniappTask(task);
      sendJson(response, task.status === "failed" || task.status === "login_required" ? 502 : 200, apiTaskPayload(task));
      return;
    }
    const canonicalMiniStatusMatch = url.pathname.match(/^\/api\/qq\/miniapp\/(?:code\/)?status\/([^/]+)$/);
    if (canonicalMiniStatusMatch && ["GET", "POST"].includes(method)) {
      const task = taskForRequest(canonicalMiniStatusMatch[1], "miniapp-login", session, true);
      sendJson(response, 200, apiTaskPayload(await miniappStatus(task)));
      return;
    }
    const canonicalMiniCodeMatch = url.pathname.match(/^\/api\/qq\/miniapp\/code\/([^/]+)$/);
    if (canonicalMiniCodeMatch && ["GET", "POST"].includes(method)) {
      const task = taskForRequest(canonicalMiniCodeMatch[1], "miniapp-login", session, true);
      sendJson(response, 200, apiTaskPayload(await miniappStatus(task)));
      return;
    }
    if (url.pathname === "/api/login/start" && method === "POST") {
      sendJson(response, 200, { ok: true, task: publicTask(await loginStart(session.id)) });
      return;
    }
    const loginMatch = url.pathname.match(/^\/api\/login\/status\/([^/]+)$/);
    if (loginMatch && method === "GET") {
      const task = taskForRequest(loginMatch[1], "napcat-login", session, true);
      sendJson(response, 200, { ok: true, task: publicTask(await loginStatus(task)) });
      return;
    }
    const loginRefreshMatch = url.pathname.match(/^\/api\/login\/refresh\/([^/]+)$/);
    if (loginRefreshMatch && method === "POST") {
      const task = taskForRequest(loginRefreshMatch[1], "napcat-login", session, true);
      sendJson(response, 200, { ok: true, task: publicTask(await refreshLogin(task)) });
      return;
    }
    if (url.pathname === "/api/miniapp/start" && method === "POST") {
      const body = await parseBody(request);
      sendJson(response, 200, { ok: true, task: publicTask(await miniappStart(body.appId, session.id)) });
      return;
    }
    const miniMatch = url.pathname.match(/^\/api\/miniapp\/status\/([^/]+)$/);
    if (miniMatch && method === "GET") {
      const task = taskForRequest(miniMatch[1], "miniapp-login", session, true);
      sendJson(response, 200, { ok: true, task: publicTask(await miniappStatus(task)) });
      return;
    }
    if (url.pathname === "/api/miniapp/exchange" && method === "POST") {
      sendJson(response, 200, { ok: true, result: await exchangeMiniappCode(await parseBody(request)) });
      return;
    }
    if (method === "GET" && await serveStatic(response, url.pathname)) return;
    sendJson(response, 404, { ok: false, error: "Not found" });
  } catch (error) {
    const status = Number.isInteger(error.status) ? error.status : 502;
    sendJson(response, status, { ok: false, code: error.code, error: error.message, details: error.payload });
  }
}

export function createServer() {
  return http.createServer((request, response) => {
    route(request, response);
  });
}

const cleanupTimer = setInterval(() => {
  expireWorkflowIfNeeded();
  const cutoff = Date.now() - 10 * 60 * 1000;
  for (const [id, task] of tasks) {
    if (task.expiresAt < cutoff || task.createdAt < cutoff) tasks.delete(id);
  }
  const sessionCutoff = Date.now() - config.sessionTtlMs;
  for (const [id, session] of visitorSessions) {
    if (session.lastSeenAt < sessionCutoff) visitorSessions.delete(id);
  }
}, 60_000);
cleanupTimer.unref();

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  createServer().listen(config.port, config.host, () => {
    console.log(`qq-miniapp-auth listening at http://${config.host}:${config.port}`);
    console.log(`NapCat API: ${config.napcatApiUrl}`);
    console.log(`Bridge: ${config.bridgeUrl || "not configured"}`);
  });
}

export { config, validAppId, normalizeBridgeResult };
