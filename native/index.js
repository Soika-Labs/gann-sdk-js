/* eslint-disable @typescript-eslint/no-var-requires */

const path = require("node:path");

function resolveTriple() {
	const platform = process.platform;
	const arch = process.arch;
	if (platform === "linux") {
		return `linux-${arch}-gnu`;
	}

	if (platform === "win32") {
		return `win32-${arch}-msvc`;
	}

	return `${platform}-${arch}`;
}

function resolvePlatformPackageName() {
	return `@soika/gann-sdk-quic-native-${resolveTriple()}`;
}

// Preferred path (published): platform-specific optional dependency package.
try {
	// eslint-disable-next-line @typescript-eslint/no-var-requires
	module.exports = require(resolvePlatformPackageName());
	return;
} catch {
	// fall through
}

const candidates = [
	// Most common output from `napi build --platform`
	`gann_js_quic_native.${resolveTriple()}.node`,
	// Some publishing setups rename to the generic name
	"gann_js_quic_native.node",
];

for (const filename of candidates) {
	try {
		module.exports = require(path.join(__dirname, filename));
		break;
	} catch {
		// try next
	}
}

if (!module.exports) {
	throw new Error(
		`Failed to load native addon. Tried: ${candidates.join(", ")}. ` +
			`platform=${process.platform} arch=${process.arch}`
	);
}
