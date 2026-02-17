const path = require("node:path");
const { execFileSync } = require("node:child_process");

const { getPlatformArchABI } = require("./platform");

function getNpmBin() {
  if (process.env.npm_execpath && process.env.npm_execpath.length > 0) {
    return process.execPath;
  }

  return "npm";
}

function main() {
  const platformDir = getPlatformArchABI();
  const packageDir = `./${path.join("npm", platformDir)}`;
  const npmBin = getNpmBin();
  const args = process.env.npm_execpath
    ? [process.env.npm_execpath, "publish", packageDir, "--access", "public"]
    : ["publish", packageDir, "--access", "public"];

  execFileSync(npmBin, args, {
    stdio: "inherit",
  });
}

main();
