const os = require("node:os");

function getPlatformArchABI() {
  const override = process.env.GANN_PLATFORM_ARCH_ABI;
  if (override && override.length > 0) {
    return override;
  }

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
