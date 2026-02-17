const os = require("node:os");

function getPlatformArchABI() {
  const platform = process.platform;
  const arch = process.arch;

  if (platform === "linux") {
    // Default to glibc builds.
    return `linux-${arch}-gnu`;
  }

  if (platform === "win32") {
    return `win32-${arch}-msvc`;
  }

  // darwin, freebsd, etc.
  return `${platform}-${arch}`;
}

module.exports = {
  getPlatformArchABI,
};
