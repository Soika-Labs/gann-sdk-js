const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const { getPlatformArchABI } = require("./platform");

function getNapiBin() {
  const ext = process.platform === "win32" ? ".cmd" : "";
  return path.join(__dirname, "..", "node_modules", ".bin", `napi${ext}`);
}

function main() {
  const platformDir = getPlatformArchABI();
  const typeDefDir = path.join("target", "napi-type-def");
  const npmPlatformDir = path.join("npm", platformDir);

  fs.mkdirSync(typeDefDir, { recursive: true });
  fs.mkdirSync(npmPlatformDir, { recursive: true });

  const env = {
    ...process.env,
    NAPI_TYPE_DEF_TMP_FOLDER: typeDefDir,
  };

  const napiBin = getNapiBin();

  execFileSync(napiBin, ["build", "--platform", "--release", npmPlatformDir], {
    stdio: "inherit",
    env,
  });

  const binaryName = `gann_js_quic_native.${platformDir}.node`;
  const src = path.join(process.cwd(), npmPlatformDir, binaryName);
  const dest = path.join(process.cwd(), binaryName);

  if (fs.existsSync(src)) {
    fs.copyFileSync(src, dest);
  }
}

main();
