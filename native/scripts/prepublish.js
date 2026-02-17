const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

function runNapi(args, options) {
  if (process.env.npm_execpath) {
    execFileSync(
      process.execPath,
      [process.env.npm_execpath, "exec", "--", "napi", ...args],
      options
    );
    return;
  }

  const ext = process.platform === "win32" ? ".cmd" : "";
  const napiBin = path.join(__dirname, "..", "node_modules", ".bin", `napi${ext}`);
  execFileSync(napiBin, args, options);
}

function main() {
  const typeDefDir = path.join("target", "napi-type-def");
  fs.mkdirSync(typeDefDir, { recursive: true });

  const args = new Set(process.argv.slice(2));
  const publish = args.has("--publish");
  const dryRun = args.has("--dry-run") || !publish;

  const env = {
    ...process.env,
    NAPI_TYPE_DEF_TMP_FOLDER: typeDefDir,
  };

  runNapi(["create-npm-dir", "-t", "."], {
    stdio: "inherit",
    env,
  });

  const prepublishArgs = ["prepublish", "-t", "npm", "-p", "npm"];
  if (dryRun) {
    prepublishArgs.push("--dry-run");
  }

  runNapi(prepublishArgs, {
    stdio: "inherit",
    env,
  });
}

main();
