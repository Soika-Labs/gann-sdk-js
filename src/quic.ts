import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";

export type QuicOffer = {
  candidates: string[];
  cert_der_b64: string;
  fingerprint_sha256: string;
  alpn: string;
  server_name: string;
  e2ee_pubkey_b64?: string | null;
};

export type QuicAnswer = {
  ok: boolean;
  error?: string | null;
};

export type QuicRelayInfo = {
  session_id: string;
  quic_addr: string;
  server_fingerprint_sha256: string;
  alpn?: string | null;
  server_name?: string | null;
};

export type QuicRelayDataFrame = {
  session_id: string;
  from: string;
  to: string;
  payload: unknown;
};

type Native = {
  PeerServer: { create(bindAddr: string): unknown };
  PeerClient: { create(bindAddr: string): unknown };
  RelayClient: { create(bindAddr: string): unknown };
  E2eeKeyPairHandle?: { generate(): unknown };
  E2EeKeyPairHandle?: { generate(): unknown };
  encrypt_relay_payload(sharedKey: Buffer, sessionId: string, plaintextJson: string): string;
  decrypt_relay_payload(sharedKey: Buffer, sessionId: string, payloadJson: string): string;
};

function resolveMethod(target: any, names: string[]): any {
  for (const name of names) {
    const method = target?.[name];
    if (typeof method === "function") {
      return method.bind(target);
    }
  }
  throw new Error(`Native method not found. Tried: ${names.join(", ")}`);
}

function loadNative(): Native {
  const envPath = process?.env?.GANN_JS_QUIC_NATIVE_PATH || process?.env?.GANN_QUIC_NATIVE_PATH;
  const require = createRequire(import.meta.url);

  // Preferred path (production): prebuilt napi-rs package.
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return require("@soika/gann-sdk-quic-native") as Native;
  } catch {
    // fall back to local development paths
  }

  const baseDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const defaultRelease = path.join(baseDir, "native", "target", "release", "gann_js_quic_native.node");
  const defaultDebug = path.join(baseDir, "native", "target", "debug", "gann_js_quic_native.node");

  const candidates = [envPath, defaultRelease, defaultDebug].filter(Boolean) as string[];

  for (const candidate of candidates) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      return require(candidate) as Native;
    } catch {
      // continue
    }
  }

  throw new Error(
    "JS QUIC native module not found. Install the prebuilt binary via `npm install @soika/gann-sdk-quic-native` " +
      "(recommended), or build it via `cargo build --release` in client/js-sdk/native, or set GANN_JS_QUIC_NATIVE_PATH " +
      "to a built .node file."
  );
}

function parseJson<T>(raw: string): T {
  return JSON.parse(raw) as T;
}

function stringifyJson(value: unknown): string {
  return JSON.stringify(value);
}

function normalizeCandidate(candidate: string): string {
  const value = String(candidate ?? "").trim();
  if (!value) {
    return value;
  }

  // IPv6 in bracket form: [addr]:port
  const bracketMatch = value.match(/^\[([^\]]+)\]:(\d+)$/);
  if (bracketMatch) {
    const [, host, port] = bracketMatch;
    if (host === "::" || host === "0:0:0:0:0:0:0:0") {
      return `[::1]:${port}`;
    }
    return value;
  }

  // Host:port (IPv4/hostname)
  const index = value.lastIndexOf(":");
  if (index <= 0 || index === value.length - 1) {
    return value;
  }
  const host = value.slice(0, index);
  const port = value.slice(index + 1);
  if (!/^\d+$/.test(port)) {
    return value;
  }

  if (host === "0.0.0.0") {
    return `127.0.0.1:${port}`;
  }
  if (host === "::") {
    return `[::1]:${port}`;
  }
  return value;
}

function normalizeOfferCandidates(offer: QuicOffer): QuicOffer {
  if (!Array.isArray(offer.candidates) || offer.candidates.length === 0) {
    return offer;
  }
  return {
    ...offer,
    candidates: offer.candidates.map(normalizeCandidate),
  };
}

export class QuicPeerServer {
  private readonly native: any;

  private constructor(native: any) {
    this.native = native;
  }

  static create(bindAddr: string): QuicPeerServer {
    const native = loadNative();
    return new QuicPeerServer((native.PeerServer as any).create(bindAddr));
  }

  offer(advertisedCandidates?: string[]): QuicOffer {
    const offerJson = resolveMethod(this.native, ["offer_json", "offerJson"]);
    const raw = offerJson(advertisedCandidates ? stringifyJson(advertisedCandidates) : undefined);
    return normalizeOfferCandidates(parseJson<QuicOffer>(raw));
  }

  async accept(): Promise<QuicPeerConnection> {
    const conn = await this.native.accept();
    return new QuicPeerConnection(conn);
  }

  close(errorCode = 0, reason?: string): void {
    this.native.close(errorCode, reason);
  }
}

export class QuicPeerClient {
  private readonly native: any;

  private constructor(native: any) {
    this.native = native;
  }

  static create(bindAddr: string): QuicPeerClient {
    const native = loadNative();
    return new QuicPeerClient((native.PeerClient as any).create(bindAddr));
  }

  async connect(offer: QuicOffer): Promise<QuicPeerConnection> {
    const conn = await this.native.connect(stringifyJson(offer));
    return new QuicPeerConnection(conn);
  }
}

export class QuicPeerConnection {
  private readonly native: any;

  constructor(native: any) {
    this.native = native;
  }

  remoteAddress(): string {
    const remoteAddress = resolveMethod(this.native, ["remote_address", "remoteAddress"]);
    return remoteAddress();
  }

  async openBi(): Promise<QuicBiStream> {
    const openBi = resolveMethod(this.native, ["open_bi", "openBi"]);
    const stream = await openBi();
    return new QuicBiStream(stream);
  }

  async acceptBi(): Promise<QuicBiStream> {
    const acceptBi = resolveMethod(this.native, ["accept_bi", "acceptBi"]);
    const stream = await acceptBi();
    return new QuicBiStream(stream);
  }

  close(errorCode = 0, reason?: string): void {
    this.native.close(errorCode, reason);
  }
}

export class QuicBiStream {
  private readonly native: any;

  constructor(native: any) {
    this.native = native;
  }

  async write(data: Buffer): Promise<void> {
    await this.native.write(data);
  }

  async finish(): Promise<void> {
    await this.native.finish();
  }

  async read(maxBytes?: number): Promise<Buffer | null> {
    const out = await this.native.read(maxBytes);
    return out ?? null;
  }
}

export class QuicRelayClient {
  private readonly native: any;

  private constructor(native: any) {
    this.native = native;
  }

  static create(bindAddr: string): QuicRelayClient {
    const native = loadNative();
    return new QuicRelayClient((native.RelayClient as any).create(bindAddr));
  }

  async connectTransport(relay: QuicRelayInfo): Promise<QuicRelayTransport> {
    const connectTransport = resolveMethod(this.native, ["connect_transport", "connectTransport"]);
    const transport = await connectTransport(stringifyJson(relay));
    return new QuicRelayTransport(transport);
  }
}

export class QuicRelayTransport {
  private readonly native: any;

  constructor(native: any) {
    this.native = native;
  }

  async relayBind(token: string, sessionId: string): Promise<boolean> {
    const relayBind = resolveMethod(this.native, ["relay_bind", "relayBind"]);
    return relayBind(token, sessionId);
  }

  async relaySend(token: string, sessionId: string, payload: unknown): Promise<void> {
    const relaySend = resolveMethod(this.native, ["relay_send", "relaySend"]);
    await relaySend(token, sessionId, stringifyJson(payload));
  }

  async recvRelayData(): Promise<QuicRelayDataFrame> {
    const recvRelayData = resolveMethod(this.native, ["recv_relay_data", "recvRelayData"]);
    const raw = await recvRelayData();
    return parseJson<QuicRelayDataFrame>(raw);
  }

  async relaySendE2ee(token: string, sessionId: string, sharedKey: Buffer, plaintext: unknown): Promise<void> {
    const relaySendE2ee = resolveMethod(this.native, ["relay_send_e2ee", "relaySendE2ee"]);
    await relaySendE2ee(token, sessionId, sharedKey, stringifyJson(plaintext));
  }

  async recvRelayDataE2ee(sharedKey: Buffer): Promise<QuicRelayDataFrame> {
    const recvRelayDataE2ee = resolveMethod(this.native, ["recv_relay_data_e2ee", "recvRelayDataE2ee"]);
    const raw = await recvRelayDataE2ee(sharedKey);
    return parseJson<QuicRelayDataFrame>(raw);
  }

  close(errorCode = 0, reason?: string): void {
    this.native.close(errorCode, reason);
  }
}

export class E2eeKeyPair {
  private readonly native: any;

  private constructor(native: any) {
    this.native = native;
  }

  static generate(): E2eeKeyPair {
    const native = loadNative();
    const keyPairHandle = (native.E2eeKeyPairHandle as any) ?? (native.E2EeKeyPairHandle as any);
    if (!keyPairHandle || typeof keyPairHandle.generate !== "function") {
      throw new Error("Native E2EE keypair handle not found");
    }
    return new E2eeKeyPair(keyPairHandle.generate());
  }

  publicKeyB64(): string {
    const publicKeyB64 = resolveMethod(this.native, ["public_key_b64", "publicKeyB64"]);
    return publicKeyB64();
  }

  deriveRelaySharedKey(peerPublicKeyB64: string, sessionId: string): Buffer {
    const deriveRelaySharedKey = resolveMethod(this.native, ["derive_relay_shared_key", "deriveRelaySharedKey"]);
    return deriveRelaySharedKey(peerPublicKeyB64, sessionId);
  }
}

export function encryptRelayPayload(sharedKey: Buffer, sessionId: string, plaintext: unknown): unknown {
  const native = loadNative();
  const encryptRelayPayloadNative =
    typeof (native as any).encrypt_relay_payload === "function"
      ? (native as any).encrypt_relay_payload
      : (native as any).encryptRelayPayload;
  const raw = encryptRelayPayloadNative(sharedKey, sessionId, stringifyJson(plaintext));
  return parseJson(raw);
}

export function decryptRelayPayload(sharedKey: Buffer, sessionId: string, payload: unknown): unknown {
  const native = loadNative();
  const decryptRelayPayloadNative =
    typeof (native as any).decrypt_relay_payload === "function"
      ? (native as any).decrypt_relay_payload
      : (native as any).decryptRelayPayload;
  const raw = decryptRelayPayloadNative(sharedKey, sessionId, stringifyJson(payload));
  return parseJson(raw);
}
