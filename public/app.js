const $ = (selector) => document.querySelector(selector);
let loginTaskId = null;

function setHealth(ok, text) {
  const el = $("#health");
  el.classList.toggle("ok", ok);
  el.classList.toggle("bad", !ok);
  el.lastElementChild.textContent = text;
}

function setLoginStatus(text) { $("#loginStatus").textContent = text; }

function friendlyError(error) {
  if (error?.code === "WORKFLOW_BUSY") return "当前有其他用户正在使用 NapCat，请稍后再试";
  if (error?.code === "LOGOUT_REQUIRED") return "上一位用户的 QQ 尚未完成注销，请稍后再试";
  if (error?.code === "WORKFLOW_REQUIRED" || error?.code === "LOGIN_REQUIRED") return "请先完成 QQ 扫码登录";
  return error?.message || "请求失败";
}

async function api(url, options) {
  const response = await fetch(url, { credentials: "include", headers: { Accept: "application/json", ...(options?.headers || {}) }, ...options });
  const body = await response.json().catch(() => ({ ok: false, error: "Invalid server response" }));
  if (!response.ok || body.ok === false) {
    const error = new Error(body.error || `HTTP ${response.status}`);
    error.code = body.code;
    error.details = body.details;
    throw error;
  }
  return body;
}

function renderQr(task) {
  const frame = $("#qrFrame");
  frame.replaceChildren();
  if (task.qrImage) {
    const image = document.createElement("img");
    image.src = task.qrImage;
    image.alt = "QQ 扫码登录二维码";
    frame.append(image);
  } else {
    const placeholder = document.createElement("div");
    placeholder.className = "qr-placeholder";
    placeholder.textContent = task.status === "success" ? "QQ 已登录" : "等待 NapCat 返回二维码";
    frame.append(placeholder);
  }
  $("#loginTask").textContent = `任务 ${task.id}`;
  $("#loginTask").classList.remove("hidden");
  const refresh = $("#refreshLogin");
  refresh.classList.toggle("hidden", !["webui-api", "napcat-file"].includes(task.mode) || task.status === "success");
}

async function pollLogin() {
  if (!loginTaskId) return;
  try {
    const { task } = await api(`/api/qq/login/status/${encodeURIComponent(loginTaskId)}`);
    renderQr(task);
    if (task.status === "success") {
      setLoginStatus("登录成功");
      await refreshUser();
      return;
    }
    if (task.status === "failed" || task.status === "expired") {
      setLoginStatus(task.error || (task.status === "expired" ? "登录任务已过期" : "登录失败"));
      return;
    }
    if (task.status === "cancelled" || task.state === "cancelled") {
      setLoginStatus(task.error || "用户已取消登录");
      return;
    }
    setLoginStatus(task.state === "scanned" ? "已扫码，等待确认登录…" : "等待扫码确认…");
    window.setTimeout(pollLogin, 1500);
  } catch (error) {
    setLoginStatus(friendlyError(error));
    window.setTimeout(pollLogin, 2500);
  }
}

async function startLogin() {
  const button = $("#startLogin");
  button.disabled = true;
  setLoginStatus("创建登录任务…");
  try {
    const { task } = await api("/api/qq/login/qrcode", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    loginTaskId = task.id;
    renderQr(task);
    setLoginStatus(task.status === "success" ? "登录成功" : "请扫描页面中的二维码登录");
    if (task.status === "success") await refreshUser(); else pollLogin();
  } catch (error) {
    setLoginStatus(friendlyError(error));
  } finally {
    button.disabled = false;
  }
}

async function refreshLogin() {
  if (!loginTaskId) return;
  const button = $("#refreshLogin");
  button.disabled = true;
  try {
    const { task } = await api(`/api/qq/login/refresh/${encodeURIComponent(loginTaskId)}`, { method: "POST" });
    renderQr(task);
    setLoginStatus("二维码已刷新，请扫码确认");
    pollLogin();
  } catch (error) {
    setLoginStatus(friendlyError(error));
  } finally {
    button.disabled = false;
  }
}

async function refreshUser() {
  try {
    const { user } = await api("/api/user");
    const id = user?.user_id ?? user?.uin ?? user?.id ?? "未知";
    const name = user?.nickname || user?.nick || "未命名用户";
    $("#nickname").textContent = name;
    $("#userId").textContent = `QQ ID ${id}`;
    $("#avatar").textContent = String(name).slice(0, 1).toUpperCase();
    $("#userError").textContent = "";
  } catch (error) {
    $("#userError").textContent = friendlyError(error);
  }
}

async function startMiniapp(event) {
  event.preventDefault();
  const appId = $("#appId").value.trim();
  const button = $("#startMini");
  const result = $("#miniResult");
  result.className = "result-box";
  result.textContent = "创建小程序登录任务…";
  button.disabled = true;
  try {
    const { task } = await api("/api/qq/miniapp/code", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ appId }) });
    renderMiniQr(task);
    await pollMiniapp(task.id);
  } catch (error) {
    result.className = "result-box error";
    result.textContent = friendlyError(error);
  } finally {
    button.disabled = false;
  }
}

async function pollMiniapp(taskId) {
  const result = $("#miniResult");
  try {
    const { task } = await api(`/api/qq/miniapp/status/${encodeURIComponent(taskId)}`);
    renderMiniQr(task);
    if (task.status === "success" && task.code) {
      result.className = task.logoutStatus === "failed" ? "result-box error" : "result-box success";
      setLoginStatus(task.logoutStatus === "failed" ? "code 已获取，但 QQ 自动注销失败" : "code 已获取，QQ 已注销，可供下一位用户使用");
      result.textContent = task.logoutStatus === "failed"
        ? `${task.code}（code 已获取，但 QQ 自动注销失败：${task.logoutError || "请检查 NapCat 插件"}）`
        : task.code;
      return;
    }
    if (task.status === "failed" || task.status === "expired" || task.status === "login_required") {
      result.className = "result-box error";
      result.textContent = task.error || (task.status === "expired" ? "任务已过期" : "获取失败");
      return;
    }
    result.textContent = "等待 NapCat 返回 code…";
    window.setTimeout(() => pollMiniapp(taskId), 1200);
  } catch (error) {
    result.className = "result-box error";
    result.textContent = friendlyError(error);
  }
}

function renderMiniQr(task) {
  const frame = $("#miniQrFrame");
  if (!task?.qrImage) {
    frame.replaceChildren();
    frame.classList.add("hidden");
    return;
  }
  frame.classList.remove("hidden");
  frame.replaceChildren();
  const image = document.createElement("img");
  image.src = task.qrImage;
  image.alt = "QQ 小程序登录二维码";
  frame.append(image);
}

async function boot() {
  try {
    const health = await api("/api/health");
    setHealth(true, health.bridgeConfigured ? "NapCat / Bridge 已配置" : health.webUiConfigured ? "NapCat WebUI 已配置" : health.qrFileConfigured ? "已找到 NapCat 二维码文件" : "等待 NapCat 登录配置");
    if (health.workflowBusy) setHealth(true, "NapCat 正被其他用户占用");
  } catch (error) {
    setHealth(false, friendlyError(error));
  }
  await refreshUser();
}

$("#startLogin").addEventListener("click", startLogin);
$("#refreshLogin").addEventListener("click", refreshLogin);
$("#refreshUser").addEventListener("click", refreshUser);
$("#miniForm").addEventListener("submit", startMiniapp);
boot();
