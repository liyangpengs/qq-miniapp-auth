import http from "node:http";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import QRCode from "qrcode";

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const tasks = new Map();
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
  bridgeMiniCancelPath: process.env.BRIDGE_MINIAPP_CANCEL_PATH || "/api/miniapp/login/cancel",
  bridgeLogoutPath: process.env.BRIDGE_LOGOUT_PATH || "/api/qq/logout",
  workflowTtlMs: numberEnv("WORKFLOW_TTL_MS", 2 * 60 * 1000),
  taskTtlMs: numberEnv("TASK_TTL_MS", 2 * 60 * 1000),
  apiSigningSecret: process.env.API_SIGNING_SECRET || process.env.SIGNING_SECRET || "qq-miniapp-auth-default-signing-secret",
  corsOrigin: process.env.CORS_ORIGIN || "same-origin",
  miniappSecrets: parseSecrets(process.env.MINIAPP_SECRETS || "{}")
};

let webUiCredential = config.napcatWebUiCredential;
let loginStartPromise = null;

function numberEnv(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function trimSlash(value) {
  return value.replace(/\/+$/, "");
}

function requiresApiSignature(pathname) {
  return pathname === "/api/qq/login/qrcode" ||
    pathname === "/api/qq/login/status" ||
    pathname === "/api/qq/login/status/" ||
    pathname === "/api/qq/miniapp/code" ||
    pathname === "/api/qq/logout";
}

function verifyApiSignature(request) {
  const received = String(request.headers["x-api-signature"] || "");
  if (!received) return { ok: false, code: "SIGNATURE_REQUIRED", error: "X-API-Signature header is required" };
  if (received !== config.apiSigningSecret) return { ok: false, code: "INVALID_SIGNATURE", error: "Invalid API signature" };
  return { ok: true };
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

function scheduleTaskExpiry(task) {
  if (task.expirationTimer) clearTimeout(task.expirationTimer);
  const delay = Math.max(1, task.expiresAt - Date.now() + 5);
  task.expirationTimer = setTimeout(() => { void expireTaskIfNeeded(task); }, delay);
  task.expirationTimer.unref?.();
}

function removeTaskFromCache(task) {
  if (!task) return;
  if (task.expirationTimer) clearTimeout(task.expirationTimer);
  task.expirationTimer = undefined;
  if (tasks.get(task.id) === task) tasks.delete(task.id);
}

function removeTaskAndLinks(task) {
  if (!task) return;
  removeTaskFromCache(task);
  if (task.kind === "napcat-login") {
    for (const candidate of tasks.values()) {
      if (candidate.kind === "miniapp-login" && candidate.loginTaskId === task.id) removeTaskFromCache(candidate);
    }
  } else if (task.kind === "miniapp-login" && task.loginTaskId) {
    removeTaskFromCache(tasks.get(task.loginTaskId));
  }
}

function createTask(kind, values = {}, ownerKey) {
  const task = {
    id: makeId(),
    kind,
    status: "pending",
    createdAt: Date.now(),
    expiresAt: Date.now() + config.taskTtlMs,
    ownerKey,
    ...values
  };
  tasks.set(task.id, task);
  scheduleTaskExpiry(task);
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
    const loginTask = activeWorkflow.loginTaskId && tasks.get(activeWorkflow.loginTaskId);
    const miniTask = activeWorkflow.miniappTaskId && tasks.get(activeWorkflow.miniappTaskId);
    const waitingForRelease = [loginTask, miniTask].some((task) => task &&
      (["pending", "scanned", "success"].includes(task.status) || ["pending", "failed"].includes(task.logoutStatus))
    );
    if (!waitingForRelease) activeWorkflow = null;
  }
  return activeWorkflow;
}

function acquireWorkflow(ownerKey) {
  const current = expireWorkflowIfNeeded();
  if (current && current.ownerKey !== ownerKey) throw makeWorkflowBusyError(current);
  if (!current) {
    activeWorkflow = {
      ownerKey,
      phase: "login",
      acquiredAt: Date.now(),
      expiresAt: Date.now() + config.workflowTtlMs,
      loginTaskId: "",
      miniappTaskId: ""
    };
  }
  return activeWorkflow;
}

function requireWorkflowOwner(ownerKey) {
  const current = expireWorkflowIfNeeded();
  if (!current) {
    const error = new Error("请先创建 QQ 扫码登录任务");
    error.status = 409;
    error.code = "WORKFLOW_REQUIRED";
    throw error;
  }
  if (current.ownerKey !== ownerKey) throw makeWorkflowBusyError(current);
  current.expiresAt = Date.now() + config.workflowTtlMs;
  return current;
}

function releaseWorkflow(ownerKey) {
  if (!activeWorkflow || (ownerKey && activeWorkflow.ownerKey !== ownerKey)) return;
  activeWorkflow = null;
}

function publicTask(task) {
  if (!task) return null;
  const login = task.kind === "napcat-login";
  const status = login ? loginState(task) : task.status;
  return {
    id: task.id,
    type: login ? "qq-login" : "miniapp-code",
    appId: task.appId,
    loginTaskId: task.loginTaskId,
    status,
    qrUrl: task.qrUrl,
    qrImage: task.qrImage,
    code: !login && task.status === "success" && task.logoutStatus === "success" ? task.code : undefined,
    scanned: task.scanned,
    confirmed: task.confirmed,
    cancelled: task.cancelled,
    logoutStatus: task.logoutStatus,
    logoutMethod: task.logoutMethod,
    logoutError: task.logoutError,
    released: task.released === true,
    error: task.error,
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

function expiredTaskPayload(taskId, type) {
  return {
    id: typeof taskId === "string" && taskId.trim() ? taskId : undefined,
    type,
    status: "expired",
    cancelled: true,
    released: true,
    error: "Task not found or expired",
    expiresAt: Date.now()
  };
}

function taskResponseOk(task) {
  return Boolean(task) && !["expired", "failed", "login_required"].includes(task.status);
}

function normalizeBridgeResult(value) {
  if (!value || typeof value !== "object") return {};
  if (value.data && typeof value.data === "object" && !Array.isArray(value.data)) {
    return { ...value, ...value.data };
  }
  return value;
}

function normalizeWebUiResult(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const result = { ...value };
  const merge = (candidate) => {
    if (candidate && typeof candidate === "object" && !Array.isArray(candidate)) Object.assign(result, candidate);
  };
  merge(value.data);
  merge(value.result);
  merge(value.data?.result);
  return result;
}

function resultCandidates(value) {
  if (!value || typeof value !== "object") return [value];
  return [value, value.data, value.result, value.data?.result].filter((candidate) => candidate && typeof candidate === "object");
}

function firstResultField(value, names) {
  for (const candidate of resultCandidates(value)) {
    for (const name of names) if (candidate[name] !== undefined && candidate[name] !== null) return candidate[name];
  }
  return undefined;
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
      return normalizeWebUiResult(payload);
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

function createLoginTask(ownerKey, values = {}) {
  const task = createTask("napcat-login", values, ownerKey);
  if (activeWorkflow && activeWorkflow.ownerKey === ownerKey) {
    activeWorkflow.loginTaskId = task.id;
    activeWorkflow.phase = task.status === "success" ? "awaiting_code" : "login";
    activeWorkflow.expiresAt = Math.max(activeWorkflow.expiresAt, task.expiresAt);
  }
  return task;
}

async function loginStart() {
  const ownerKey = makeId();
  await ensureLogoutRecovery();
  const current = expireWorkflowIfNeeded();
  if (current) throw makeWorkflowBusyError(current);
  if (loginStartPromise) {
    throw makeWorkflowBusyError(activeWorkflow);
  }
  acquireWorkflow(ownerKey);
  const operation = loginStartInternal(ownerKey);
  loginStartPromise = operation;
  try {
    return await operation;
  } catch (error) {
    releaseWorkflow(ownerKey);
    throw error;
  } finally {
    if (loginStartPromise === operation) {
      loginStartPromise = null;
    }
  }
}

async function loginStartInternal(ownerKey) {
  if (!isWebUiConfigured()) {
    const qrImage = readNapcatQrImage();
    if (qrImage) {
      const task = createLoginTask(ownerKey, { mode: "napcat-file", qrImage });
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
      if (hasLoggedInUser(user)) return createLoginTask(ownerKey, { mode: "onebot", status: "success", user });
    } catch {
      // Fall through to the actionable configuration error below.
    }
    throw new Error("NapCat QR login is not configured. Set NAPCAT_WEBUI_TOKEN/NAPCAT_WEBUI_CONFIG or NAPCAT_QR_IMAGE_PATH, then retry.");
  }
  try {
    try {
      await webUiCall("/QQLogin/RefreshQRcode");
    } catch {
      // Older NapCat versions may create a fresh QR directly from the getter.
    }
    const result = await webUiCall("/QQLogin/GetQQLoginQrcode");
    const qrValue = pickQrValue(result);
    const qrImage = await makeQrImage(qrValue);
    if (!qrImage) throw new Error("NapCat WebUI did not return a usable QR code");
    return createLoginTask(ownerKey, {
      mode: "webui-api",
      qrUrl: /^https?:\/\//i.test(String(qrValue || "")) ? qrValue : undefined,
      qrImage
    });
  } catch (error) {
    // 已经登录时 GetQQLoginQrcode 会返回错误，继续读取当前账号。
    try {
      const user = await webUiCall("/QQLogin/GetQQLoginInfo");
      if (hasLoggedInUser(user)) return createLoginTask(ownerKey, { mode: "webui-api", status: "success", user });
      throw error;
    } catch {
      throw error;
    }
  }
}

function mapStatus(result) {
  const status = String(firstResultField(result, ["status", "state", "loginStatus", "login_state"]) || "pending").trim().toLowerCase();
  if (["ok", "success", "succeeded", "logged_in", "connected"].includes(status)) return "success";
  if (["login_required", "not_logged_in", "unauthenticated"].includes(status)) return "login_required";
  if (["failed", "error", "rejected"].includes(status)) return "failed";
  if (["cancelled", "canceled"].includes(status)) return "cancelled";
  if (["expired", "timeout"].includes(status)) return "expired";
  return "pending";
}

function truthyField(value, names) {
  for (const name of names) {
    const field = firstResultField(value, [name]);
    if (field === true || field === 1 || String(field || "").trim().toLowerCase() === "true") return true;
  }
  return false;
}

function booleanField(value, names) {
  const field = firstResultField(value, names);
  if (field === true || field === 1) return true;
  if (field === false || field === 0) return false;
  const text = String(field || "").trim().toLowerCase();
  if (["true", "yes", "on", "logged_in", "success"].includes(text)) return true;
  if (["false", "no", "off", "not_logged_in", "pending"].includes(text)) return false;
  return undefined;
}

function applyLoginStatus(task, result) {
  const state = String(firstResultField(result, ["status", "state", "loginStatus", "login_state", "qrcodeStatus", "scanStatus"]) || "").trim().toLowerCase();
  const message = String(firstResultField(result, ["loginError", "error", "message", "msg", "wording"]) || "").trim().toLowerCase();
  const isLogin = booleanField(result, ["isLogin", "is_login", "loggedIn", "logged_in"]);
  const expired = ["expired", "timeout"].includes(state) || /expired|timeout|二维码.*过期|已过期|失效/.test(`${state} ${message}`);
  const cancelled = truthyField(result, ["cancelled", "canceled", "isCancelled", "isCanceled", "userCancelled", "userCanceled"]) ||
    /cancel|取消|拒绝|rejected/.test(`${state} ${message}`);
  const waitingScan = /waiting[_\s-]?scan|wait[_\s-]?for[_\s-]?scan|等待扫码|待扫码|未扫码/.test(`${state} ${message}`);
  const explicitScanned = truthyField(result, ["scanned", "isScanned", "isScan", "scan", "hasScan", "hasScanned", "qrcodeScanned", "qrScanned", "scanSuccess", "isScanSuccess"]) ||
    /scanned|scanning|qrcode[_\s-]?scanned|scan[_\s-]?(success|complete|completed)|已扫码|扫码成功/.test(`${state} ${message}`);
  const scanned = explicitScanned ||
    (!waitingScan && /scanned|scanning|qrcode[_\s-]?scanned|scan[_\s-]?(success|complete|completed)|(?:^|[_\s-])scan(?:$|[_\s-])|已扫码|扫码成功|待确认|等待确认|confirm/.test(`${state} ${message}`));
  const confirmed = truthyField(result, ["confirmed", "isConfirmed", "isConfirm", "confirm", "hasConfirm", "authorized", "isAuthorized"]) ||
    ["confirmed", "success", "succeeded", "logged_in", "connected"].includes(state) || isLogin === true;
  task.scanned = task.scanned || scanned || confirmed;
  task.confirmed = task.confirmed || confirmed;
  task.cancelled = task.cancelled || cancelled;
  task.error = firstResultField(result, ["loginError", "error", "message", "msg", "wording"]) || task.error;
  if (expired) task.status = "expired";
  else if (cancelled) task.status = "cancelled";
  else if (task.confirmed || isLogin === true) task.status = "success";
  else if (scanned || confirmed || task.scanned) task.status = "scanned";
  else task.status = "pending";
  return task;
}

async function loginStatus(task) {
  await expireTaskIfNeeded(task);
  if (["pending", "scanned"].includes(task.status)) {
    try {
      if (task.mode === "webui-api") {
        const result = await webUiCall("/QQLogin/CheckLoginStatus");
        applyLoginStatus(task, result);
        if (task.status === "success" || booleanField(result, ["isLogin", "is_login", "loggedIn", "logged_in"]) === true) {
          task.user = await webUiCall("/QQLogin/GetQQLoginInfo");
        }
        const nextQrValue = firstResultField(result, ["qrcodeurl", "qrcode", "qrUrl", "qr_url", "qrCode", "qr_code"]) || task.qrUrl;
        if (nextQrValue && nextQrValue !== task.qrUrl) {
          task.qrUrl = /^https?:\/\//i.test(String(nextQrValue)) ? nextQrValue : task.qrUrl;
          try { task.qrImage = await makeQrImage(nextQrValue); } catch { /* ignore */ }
        }
        task.error = firstResultField(result, ["loginError", "error", "message", "msg", "wording"]) || task.error;
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
  if (task.status === "expired") {
    await cancelTask(task, task.error || "二维码已过期，请刷新", { expired: true });
  } else if (task.status === "cancelled") {
    await cancelTask(task, task.error || "登录任务已取消");
  }
  if (task.id === activeWorkflow?.loginTaskId) {
    if (["cancelled", "expired", "failed"].includes(task.status) && !["pending", "failed"].includes(task.logoutStatus)) {
      if (task.status === "cancelled") {
        task.cancelled = true;
        task.released = true;
        task.logoutStatus = task.logoutStatus || "not_required";
      }
      releaseWorkflow(task.ownerKey);
    }
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
  const workflow = acquireWorkflow(task.ownerKey);
  workflow.loginTaskId = task.id;
  workflow.miniappTaskId = "";
  workflow.phase = "login";
  workflow.expiresAt = Date.now() + config.workflowTtlMs;
  if (task.mode === "napcat-file") {
    task.qrImage = readNapcatQrImage() || task.qrImage;
    task.status = "pending";
    task.error = undefined;
    task.expiresAt = Date.now() + config.taskTtlMs;
    scheduleTaskExpiry(task);
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
  task.expiresAt = Date.now() + config.taskTtlMs;
  scheduleTaskExpiry(task);
  task.scanned = false;
  task.confirmed = false;
  task.cancelled = false;
  if (activeWorkflow?.ownerKey === task.ownerKey) {
    activeWorkflow.phase = "login";
    activeWorkflow.expiresAt = Date.now() + config.workflowTtlMs;
  }
  return task;
}

function validAppId(appId) {
  return typeof appId === "string" && /^[A-Za-z0-9_-]{3,128}$/.test(appId);
}

async function miniappStart(appId, loginTaskId) {
  if (!validAppId(appId)) {
    const error = new Error("appId must be 3-128 ASCII letters, numbers, '_' or '-'");
    error.status = 400;
    throw error;
  }
  const loginTask = tasks.get(loginTaskId);
  if (!loginTaskId) {
    const error = new Error("请提供二维码登录任务 taskId");
    error.status = 409;
    error.code = "WORKFLOW_REQUIRED";
    error.task = expiredTaskPayload(loginTaskId, "qq-login");
    throw error;
  }
  if (!loginTask || loginTask.kind !== "napcat-login") {
    const error = new Error("请先创建 QQ 扫码登录任务");
    error.status = 409;
    error.code = "TASK_EXPIRED";
    error.task = expiredTaskPayload(loginTaskId, "qq-login");
    throw error;
  }
  if (loginTask.status === "expired") {
    const error = new Error("Login task expired");
    error.status = 409;
    error.code = "TASK_EXPIRED";
    error.task = publicTask(loginTask);
    throw error;
  }
  const workflow = requireWorkflowOwner(loginTask.ownerKey);
  await loginStatus(loginTask);
  if (loginTask.status !== "success") {
    const error = new Error("请先完成 QQ 扫码登录，再获取小程序 code");
    error.status = 409;
    error.code = "LOGIN_REQUIRED";
    error.task = publicTask(loginTask);
    throw error;
  }
  if (workflow.miniappTaskId) {
    const existing = tasks.get(workflow.miniappTaskId);
    if (existing && existing.appId === appId && ["pending", "success", "login_required", "failed"].includes(existing.status)) {
      return existing;
    }
  }
  if (workflow.miniappStartPromise) return workflow.miniappStartPromise;
  const operation = startMiniappThroughBridge(appId, loginTask.ownerKey, workflow);
  workflow.miniappStartPromise = operation;
  try {
    return await operation;
  } finally {
    if (workflow.miniappStartPromise === operation) workflow.miniappStartPromise = null;
  }
}

async function startMiniappThroughBridge(appId, ownerKey, workflow) {
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
      loginTaskId: workflow.loginTaskId,
      upstreamTaskId: result.taskId || result.task_id || result.id,
      status: result.code ? "success" : mapStatus(result),
      code: result.code,
      qrUrl: result.qrUrl || result.qr_url || result.url,
      qrImage: result.qrImage || result.qr_image,
      user: result.user,
      error: result.error || result.message
    }, ownerKey);
    workflow.miniappTaskId = task.id;
    workflow.expiresAt = Math.max(workflow.expiresAt, task.expiresAt);
    if (task.status === "success" && !task.code) {
      task.status = "failed";
      task.error = "Bridge reported success without an authorization code";
    }
    if (task.status === "success") await finalizeMiniappTask(task);
    else if (["failed", "expired", "login_required"].includes(task.status)) releaseWorkflow(ownerKey);
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
  // NapCat 4.18.x can tear down the native wrapper session while leaving its
  // WebUI QQLoginStatus flag set in memory. Ask NapCat to restart its worker
  // so the next QR request is accepted as a fresh login.
  if (isWebUiConfigured()) {
    try {
      await webUiCall("/QQLogin/RestartNapCat");
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      let lastStatus;
      for (let attempt = 0; attempt < 24; attempt += 1) {
        try {
          lastStatus = await webUiCall("/QQLogin/CheckLoginStatus");
          if (lastStatus?.isLogin !== true) break;
        } catch {
          // The worker can be briefly unavailable while it is restarting.
        }
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      if (!lastStatus || typeof lastStatus.isLogin !== "boolean") {
        const error = new Error("NapCat worker restart status could not be verified");
        error.payload = { logout: result };
        throw error;
      }
      if (lastStatus.isLogin === true) {
        const error = new Error("NapCat worker restart did not clear the login state");
        error.payload = { logout: result, status: lastStatus };
        throw error;
      }
      return { ...result, workerRestarted: true };
    } catch (error) {
      if (!error.payload) error.payload = { logout: result };
      throw error;
    }
  }
  return result;
}

async function requestNapcatLoginCancel() {
  if (!isWebUiConfigured()) return;
  try {
    await webUiCall("/QQLogin/CancelLogin");
  } catch {
    // Some NapCat versions do not expose a cancel endpoint. Releasing the
    // local task is still sufficient; the next QR request refreshes it.
  }
}

async function cancelTask(task, reason = "任务已取消", { expired = false } = {}) {
  if (!task) return task;
  if (task.status === "success" && task.logoutStatus === "success" && task.released) {
    if (expired) {
      task.status = "expired";
      task.cancelled = true;
    }
    removeTaskAndLinks(task);
    return task;
  }
  if (task.kind === "napcat-login") {
    const linkedMiniTask = [...tasks.values()].find((candidate) =>
      candidate.kind === "miniapp-login" && candidate.loginTaskId === task.id && ["pending", "scanned"].includes(candidate.status)
    );
    if (linkedMiniTask) {
      if (linkedMiniTask.mode === "bridge" && linkedMiniTask.upstreamTaskId) {
        try {
          await bridgeCall(`${config.bridgeMiniCancelPath}/${encodeURIComponent(linkedMiniTask.upstreamTaskId)}`, { method: "POST" });
        } catch {
          // The linked bridge task may already be terminal.
        }
      }
      linkedMiniTask.status = expired ? "expired" : "cancelled";
      linkedMiniTask.cancelled = true;
      linkedMiniTask.error = reason;
      linkedMiniTask.released = true;
      linkedMiniTask.logoutStatus = "delegated";
      removeTaskFromCache(linkedMiniTask);
    }
  }
  const needsLogout = task.kind === "miniapp-login" || task.status === "success";
  if (task.kind === "miniapp-login" && task.mode === "bridge" && task.upstreamTaskId) {
    try {
      await bridgeCall(`${config.bridgeMiniCancelPath}/${encodeURIComponent(task.upstreamTaskId)}`, { method: "POST" });
    } catch {
      // The bridge task may already have completed; logout below remains the
      // authoritative release operation.
    }
  } else if (task.kind === "napcat-login" && !needsLogout) {
    await requestNapcatLoginCancel();
  }
  task.status = expired ? "expired" : "cancelled";
  task.cancelled = true;
  task.error = reason;
  if (task.expirationTimer) {
    clearTimeout(task.expirationTimer);
    task.expirationTimer = undefined;
  }
  if (!needsLogout) {
    task.released = true;
    task.logoutStatus = task.logoutStatus || "not_required";
    releaseWorkflow(task.ownerKey);
    removeTaskAndLinks(task);
    return task;
  }
  if (task.logoutPromise) return task.logoutPromise;
  task.logoutStatus = "pending";
  task.logoutPromise = (async () => {
    try {
      const result = await requestNapcatLogout(task.id);
      task.logoutStatus = "success";
      task.logoutMethod = result.method || "NodeIKernelLoginService.offline";
      task.released = true;
      logoutRecoveryRequired = false;
      const loginTask = task.loginTaskId && tasks.get(task.loginTaskId);
      if (loginTask) {
        loginTask.logoutStatus = "success";
        loginTask.logoutMethod = task.logoutMethod;
        loginTask.released = true;
      }
      releaseWorkflow(task.ownerKey);
    } catch (error) {
      task.logoutStatus = "failed";
      task.logoutError = error.message;
      task.released = false;
      logoutRecoveryRequired = true;
    } finally {
      task.logoutPromise = null;
      if (task.logoutStatus === "success" || expired) removeTaskAndLinks(task);
    }
    return task;
  })();
  return task.logoutPromise;
}

async function expireTaskIfNeeded(task) {
  if (!task || task.expiresAt > Date.now()) return task;
  if (task.status === "pending" || task.status === "scanned" || task.status === "success") {
    return cancelTask(task, "任务已超过 2 分钟，已自动取消并释放", { expired: true });
  }
  return task;
}

async function ensureLogoutRecovery() {
  if (!logoutRecoveryRequired) return;
  if (!logoutRecoveryPromise) {
    logoutRecoveryPromise = (async () => {
      try {
        const result = await requestNapcatLogout("recovery");
        logoutRecoveryRequired = false;
        for (const task of tasks.values()) {
          if (task.logoutStatus === "failed") {
            task.logoutStatus = "success";
            task.logoutMethod = result.method || "NodeIKernelLoginService.offline";
            task.logoutError = undefined;
            task.released = true;
          }
        }
        releaseWorkflow();
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
      const loginTask = task.kind === "napcat-login" ? task : task.loginTaskId && tasks.get(task.loginTaskId);
      if (loginTask) {
        loginTask.logoutStatus = "success";
        loginTask.logoutMethod = task.logoutMethod;
        loginTask.released = true;
      }
    } catch (error) {
      task.logoutStatus = "failed";
      task.logoutError = error.message;
      task.released = false;
      logoutRecoveryRequired = true;
    } finally {
      if (task.logoutStatus === "success") releaseWorkflow(task.ownerKey);
      task.logoutPromise = null;
    }
    return task;
  })();
  return task.logoutPromise;
}

async function miniappStatus(task) {
  await expireTaskIfNeeded(task);
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
  else if (["expired", "cancelled"].includes(task.status) && !task.logoutStatus) {
    await cancelTask(task, task.error || "小程序授权任务已取消", { expired: task.status === "expired" });
  } else if (["failed", "expired", "cancelled", "login_required"].includes(task.status) && !["pending", "failed"].includes(task.logoutStatus)) {
    releaseWorkflow(task.ownerKey);
  }
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

function taskForRequest(taskId, kind) {
  const task = tasks.get(taskId);
  if (!task || (kind && task.kind !== kind)) {
    const error = new Error("Task not found or expired");
    error.status = 404;
    error.code = "TASK_EXPIRED";
    error.task = expiredTaskPayload(taskId, kind === "napcat-login" ? "qq-login" : kind === "miniapp-login" ? "miniapp-code" : undefined);
    throw error;
  }
  return task;
}

function miniTaskForRequest(taskId) {
  const task = tasks.get(taskId);
  if (task?.kind === "miniapp-login") return task;
  if (task?.kind === "napcat-login") {
    const linked = [...tasks.values()].find((candidate) => candidate.kind === "miniapp-login" && candidate.loginTaskId === taskId);
    if (linked) return linked;
  }
  const error = new Error("Mini-app task not found");
  error.status = 404;
  throw error;
}

function apiTaskPayload(task, ok = taskResponseOk(task)) {
  const payload = { ok, task: publicTask(task) };
  if (!ok && task?.status === "expired") {
    payload.code = "TASK_EXPIRED";
    payload.error = task.error || "Task expired";
  }
  return payload;
}

function miniappOperationPayload(task) {
  if (!task) return { ok: false, code: "TASK_EXPIRED", status: "expired" };
  if (task.status === "success" && task.code && task.logoutStatus === "success") {
    return { ok: true, code: task.code };
  }
  if (task.status === "success" && task.logoutStatus === "failed") {
    return { ok: false, code: "LOGOUT_FAILED", status: "failed", error: task.logoutError || "QQ logout failed" };
  }
  if (task.status === "expired") {
    return { ok: false, code: "TASK_EXPIRED", status: "expired", error: task.error || "Task expired" };
  }
  return {
    ok: false,
    status: task.status,
    code: task.status === "login_required" ? "LOGIN_REQUIRED" : "MINIAPP_FAILED",
    error: task.error || "Mini-app authorization failed"
  };
}

function logoutOperationPayload(task) {
  if (!task || task.status === "expired") {
    return { ok: false, code: "TASK_EXPIRED", status: "expired", error: task?.error || "Task not found or expired" };
  }
  if (task.logoutStatus === "failed") {
    return { ok: false, code: "LOGOUT_FAILED", status: task.status, error: task.logoutError || "QQ logout failed" };
  }
  return { ok: true };
}

function operationErrorPayload(error) {
  if (error?.code === "TASK_EXPIRED" || error?.task?.status === "expired") {
    return { ok: false, code: "TASK_EXPIRED", status: "expired", error: error.message || "Task not found or expired" };
  }
  const payload = { ok: false, error: error?.message || "Request failed" };
  if (error?.code) payload.code = error.code;
  if (error?.task?.status) payload.status = error.task.status;
  return payload;
}

async function waitForMiniappTask(task, timeoutMs = config.taskTtlMs) {
  const deadline = Date.now() + timeoutMs;
  while (task.status === "pending" && Date.now() < deadline) {
    await miniappStatus(task);
    if (task.status !== "pending") break;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  if (task.status === "pending") {
    await cancelTask(task, "授权任务等待超时，已自动取消", { expired: true });
    task.error = "授权任务等待超时，请重新请求";
  }
  return task;
}

async function route(request, response) {
  const url = new URL(request.url, `http://${request.headers.host || "localhost"}`);
  const method = request.method || "GET";
  try {
    if (method === "OPTIONS") {
      const headers = {
        "Access-Control-Allow-Headers": "Content-Type, Authorization, X-API-Signature",
        "Access-Control-Allow-Methods": "GET,POST,OPTIONS"
      };
      if (config.corsOrigin && config.corsOrigin !== "same-origin") {
        headers["Access-Control-Allow-Origin"] = config.corsOrigin;
        headers["Access-Control-Allow-Credentials"] = "true";
      }
      response.writeHead(200, headers);
      response.end();
      return;
    }
    if (requiresApiSignature(url.pathname)) {
      const auth = verifyApiSignature(request);
      if (!auth.ok) {
        sendJson(response, 200, auth);
        return;
      }
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
    if (url.pathname === "/api/qq/login/qrcode" && method === "POST") {
      sendJson(response, 200, apiTaskPayload(await loginStart()));
      return;
    }
    if (["/api/qq/login/status", "/api/qq/login/status/"].includes(url.pathname) && method === "POST") {
      const body = await parseBody(request);
      const task = taskForRequest(body.taskId, "napcat-login");
      const refresh = body.refresh === true || body.refresh === "true";
      const result = refresh ? await refreshLogin(task) : await loginStatus(task);
      sendJson(response, 200, apiTaskPayload(result));
      return;
    }
    if (url.pathname === "/api/qq/miniapp/code" && method === "POST") {
      const body = await parseBody(request);
      const taskId = body.taskId || body.loginTaskId;
      const existing = tasks.get(taskId);
      const task = existing?.kind === "miniapp-login" ? await miniappStatus(existing) : await miniappStart(body.appId, taskId);
      await waitForMiniappTask(task);
      const payload = miniappOperationPayload(task);
      if (["success", "expired", "failed", "cancelled", "login_required"].includes(task.status)) removeTaskAndLinks(task);
      sendJson(response, 200, payload);
      return;
    }
    if (url.pathname === "/api/qq/logout" && method === "POST") {
      const body = await parseBody(request);
      const taskId = body.taskId || body.loginTaskId;
      const task = taskForRequest(taskId);
      if (task.status === "expired") removeTaskFromCache(task);
      else await cancelTask(task, "QQ 已注销，任务已释放");
      sendJson(response, 200, logoutOperationPayload(task));
      return;
    }
    sendJson(response, url.pathname.startsWith("/api/") ? 200 : 404, { ok: false, error: "Not found" });
  } catch (error) {
    if (url.pathname === "/api/qq/miniapp/code" || url.pathname === "/api/qq/logout") {
      sendJson(response, 200, operationErrorPayload(error));
      return;
    }
    const payload = { ok: false, error: error.message || "Request failed" };
    if (error.code) payload.code = error.code;
    if (error.task) payload.task = error.task;
    sendJson(response, url.pathname.startsWith("/api/") ? 200 : (Number.isInteger(error.status) ? error.status : 502), payload);
  }
}

export function createServer() {
  return http.createServer((request, response) => {
    route(request, response);
  });
}

const cleanupTimer = setInterval(() => {
  for (const task of tasks.values()) {
    if (task.expiresAt <= Date.now() && ["pending", "scanned", "success"].includes(task.status)) {
      void expireTaskIfNeeded(task);
    }
  }
  expireWorkflowIfNeeded();
  const cutoff = Date.now() - 10 * 60 * 1000;
  for (const [id, task] of tasks) {
    if (task.expiresAt < cutoff || task.createdAt < cutoff) {
      if (task.expirationTimer) clearTimeout(task.expirationTimer);
      tasks.delete(id);
    }
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
