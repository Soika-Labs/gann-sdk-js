const fs = require("node:fs");
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
  const token = process.env.NODE_AUTH_TOKEN || process.env.NPM_TOKEN;

  if (!token) {
    throw new Error(
      "Missing npm auth token. Set NODE_AUTH_TOKEN or NPM_TOKEN before publishing."
    );
  }

  const npmrcPath = path.join(process.cwd(), ".npmrc.publish");
  fs.writeFileSync(
    npmrcPath,
    `//registry.npmjs.org/:_authToken=${token}\nalways-auth=true\n`,
    "utf8"
  );

  const npmBin = getNpmBin();
  const args = process.env.npm_execpath
    ? [process.env.npm_execpath, "publish", packageDir, "--access", "public"]
    : ["publish", packageDir, "--access", "public"];

  try {
    execFileSync(npmBin, args, {
      stdio: "inherit",
      env: {
        ...process.env,
        NODE_AUTH_TOKEN: token,
        NPM_CONFIG_USERCONFIG: npmrcPath,
      },
    });
  } finally {
    if (fs.existsSync(npmrcPath)) {
      fs.rmSync(npmrcPath);
    }
  }
}

main();
