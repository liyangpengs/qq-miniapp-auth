#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  ./install-napcat-plugin.sh /path/to/NapCat
  NAPCAT_ROOT=/path/to/NapCat ./install-napcat-plugin.sh

The NapCat directory must contain napcat.mjs. Quit QQ/NapCat before running
this installer, then restart NapCat after it finishes.
EOF
}

die() {
  echo "Error: $*" >&2
  exit 1
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
  exit 0
fi

if [[ $# -gt 1 ]]; then
  usage >&2
  exit 1
fi

NAPCAT_ROOT=${1:-${NAPCAT_ROOT:-}}
[[ -n "$NAPCAT_ROOT" ]] || die "NapCat directory is required. Run with /path/to/NapCat or set NAPCAT_ROOT."
[[ -d "$NAPCAT_ROOT" ]] || die "NapCat directory not found: $NAPCAT_ROOT"
NAPCAT_ROOT=$(cd -- "$NAPCAT_ROOT" && pwd)

if command -v pgrep >/dev/null 2>&1; then
  for process_name in qq linuxqq napcat; do
    if pgrep -x "$process_name" >/dev/null 2>&1; then
      die "QQ/NapCat appears to be running as '$process_name'. Quit it completely, then rerun this script."
    fi
  done
fi

PROJECT_ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
PLUGIN_ID="qq-miniapp-openauth"
PLUGIN_SOURCE_DIR="$PROJECT_ROOT/napcat-openauth-plugin"
PLUGIN_DIR="$NAPCAT_ROOT/plugins/$PLUGIN_ID"
PLUGIN_CONFIG_DIR="$NAPCAT_ROOT/config/plugins/$PLUGIN_ID"
PLUGIN_CONFIG_PATH="$PLUGIN_CONFIG_DIR/config.json"
NAPCAT_MAIN_PATH="$NAPCAT_ROOT/napcat.mjs"
PLUGINS_CONFIG_PATH="$NAPCAT_ROOT/config/plugins.json"
ENV_PATH="$PROJECT_ROOT/.env"
NODE_BIN=${NODE_BIN:-node}

[[ -d "$PLUGIN_SOURCE_DIR" ]] || die "Plugin source directory is missing: $PLUGIN_SOURCE_DIR"
[[ -f "$NAPCAT_MAIN_PATH" ]] || die "NapCat main file not found: $NAPCAT_MAIN_PATH"
[[ -f "$ENV_PATH" ]] || die "Project .env not found: $ENV_PATH. Copy .env.example to .env and configure it first."
command -v "$NODE_BIN" >/dev/null 2>&1 || die "Node.js executable not found: $NODE_BIN"

umask 077
mkdir -p "$PLUGIN_DIR" "$PLUGIN_CONFIG_DIR"
cp -a "$PLUGIN_SOURCE_DIR/." "$PLUGIN_DIR/"

# Remove the nested layout produced by older manual installations.
if [[ -d "$PLUGIN_DIR/napcat-openauth-plugin" ]]; then
  rm -rf -- "$PLUGIN_DIR/napcat-openauth-plugin"
fi

plugin_token=$(sed -n 's/^NAPCAT_OPEN_AUTH_PLUGIN_TOKEN=//p' "$ENV_PATH" | head -n 1)
plugin_token="${plugin_token#"${plugin_token%%[![:space:]]*}"}"
plugin_token="${plugin_token%"${plugin_token##*[![:space:]]}"}"
if [[ -z "$plugin_token" ]]; then
  plugin_token=$("$NODE_BIN" -e 'console.log(require("node:crypto").randomBytes(32).toString("base64"))')
fi

"$NODE_BIN" - "$PLUGIN_CONFIG_PATH" "$plugin_token" <<'NODE'
const fs = require("node:fs");

const filePath = process.argv[2];
const token = process.argv[3];
fs.writeFileSync(filePath, JSON.stringify({ token }, null, 2) + "\n");
NODE
chmod 600 "$PLUGIN_CONFIG_PATH"

# NapCat 4.18.19 and newer only load IDs in its official plugin whitelist.
# Add only this plugin ID and leave all other NapCat code unchanged.
if ! grep -Fq '"qq-miniapp-openauth"' "$NAPCAT_MAIN_PATH"; then
  grep -Fq '"napcat-plugin-qce"' "$NAPCAT_MAIN_PATH" ||
    die "NapCat plugin whitelist marker not found; refusing to modify napcat.mjs."

  backup_path="$NAPCAT_MAIN_PATH.bak.$(date +%Y%m%d%H%M%S)"
  cp -a "$NAPCAT_MAIN_PATH" "$backup_path"
  "$NODE_BIN" - "$NAPCAT_MAIN_PATH" <<'NODE'
const fs = require("node:fs");

const filePath = process.argv[2];
const source = fs.readFileSync(filePath, "utf8");
const pluginId = "\"qq-miniapp-openauth\"";
const marker = "\"napcat-plugin-qce\"";
const markerIndex = source.indexOf(marker);
if (markerIndex === -1) {
  throw new Error("NapCat plugin whitelist marker not found");
}
fs.writeFileSync(
  filePath,
  source.slice(0, markerIndex + marker.length) + ",\n  " + pluginId + source.slice(markerIndex + marker.length)
);
NODE
fi

"$NODE_BIN" - "$PLUGINS_CONFIG_PATH" "$PLUGIN_ID" <<'NODE'
const fs = require("node:fs");

const filePath = process.argv[2];
const pluginId = process.argv[3];
let config = {};
if (fs.existsSync(filePath)) {
  config = JSON.parse(fs.readFileSync(filePath, "utf8"));
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    throw new Error("NapCat plugins.json must contain a JSON object");
  }
}
config[pluginId] = true;
fs.writeFileSync(filePath, JSON.stringify(config, null, 2) + "\n");
NODE

"$NODE_BIN" - "$ENV_PATH" "$plugin_token" <<'NODE'
const fs = require("node:fs");

const filePath = process.argv[2];
const token = process.argv[3];
const line = `NAPCAT_OPEN_AUTH_PLUGIN_TOKEN=${token}`;
let content = fs.readFileSync(filePath, "utf8");
if (/^NAPCAT_OPEN_AUTH_PLUGIN_TOKEN=/m.test(content)) {
  content = content.replace(/^NAPCAT_OPEN_AUTH_PLUGIN_TOKEN=.*$/m, () => line);
} else if (content === "" || content.endsWith("\n")) {
  content += `${line}\n`;
} else {
  content += `\n${line}\n`;
}
fs.writeFileSync(filePath, content);
NODE
chmod 600 "$ENV_PATH"

echo "Installed NapCat plugin: $PLUGIN_ID"
echo "No QQ files were modified."
echo "Plugin route: http://127.0.0.1:6099/plugin/$PLUGIN_ID/api/miniapp"
echo "Logout route: http://127.0.0.1:6099/plugin/$PLUGIN_ID/api/logout"
echo "Restart NapCat, then check the route from the bridge."
