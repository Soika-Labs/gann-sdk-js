import type { ClientOptions as WsClientOptions, RawData } from "ws";
import type NodeWebSocket from "ws";

export type SignalingToken = {
  token: string;
  expiresAt: Date;
  rawExpiresAt: string;
};

export type SignalingPayload =
  | { kind: "quic_offer"; offer: unknown }
  | { kind: "quic_answer"; answer: unknown }
  | { kind: "quic_candidate"; candidate: unknown }
  | { kind: "quic_relay"; relay: unknown }
  | { kind: "disconnect"; reason?: string }
  | { kind: "reject"; reason: string };

export interface SignalingEvent {
  sessionId: string;
  from: string;
  to: string;
  expiresAt: Date;
  payload: SignalingPayload;
}

export type SessionState = "pending" | "active" | "terminated";

export interface SessionLifecycleEventPayload {
  sessionId: string;
  targetAgent: string;
  peerAgent: string;
  state: SessionState;
  expiresAt: Date;
  reason?: string;
}

export type ControlAction = "reject" | "disconnect" | "timeout" | "kill_switch";

export interface ControlDirectiveEvent {
  targetAgent: string;
  action: ControlAction;
  reason: string;
  sessionId?: string;
}

export interface HeartbeatBroadcast {
  agentId: string;
  timestamp: number;
  load: number;
  status: string;
}

export type ParsedSocketEvent =
  | { type: "signaling"; payload: SignalingEvent }
  | { type: "session"; payload: SessionLifecycleEventPayload }
  | { type: "control"; payload: ControlDirectiveEvent }
  | { type: "heartbeat"; payload: HeartbeatBroadcast };

export type SignalingSocketOptions = WsClientOptions | string | string[];

export interface SignalingConnectOptions {
  agentId?: string;
  token?: string;
  expiresAt?: Date;
  wsOptions?: SignalingSocketOptions;
  webSocketFactory?: WebSocketFactory;
}

export type WebSocketFactory = (url: string, options?: SignalingSocketOptions) => WebSocketLike;

export interface WebSocketLike {
  readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener?: (...args: any[]) => void;
  removeEventListener?: (...args: any[]) => void;
  on?: (...args: any[]) => void;
  off?: (...args: any[]) => void;
  once?: (...args: any[]) => void;
  removeListener?: (...args: any[]) => void;
}

export type SignalingChannelEventMap = {
  open: [];
  close: [{ code?: number; reason?: string }];
  error: [Error];
  signaling: [SignalingEvent];
  session: [SessionLifecycleEventPayload];
  control: [ControlDirectiveEvent];
  heartbeat: [HeartbeatBroadcast];
  raw: [ParsedSocketEvent];
};

type Listener<Args extends any[]> = (...args: Args) => void;

class SimpleEventEmitter<EventMap extends Record<string, any[]>> {
  private readonly listeners = new Map<keyof EventMap, Set<Listener<any[]>>>();

  on<Event extends keyof EventMap>(event: Event, listener: Listener<EventMap[Event]>): () => void {
    const bucket = this.listeners.get(event) ?? new Set();
    bucket.add(listener as Listener<any[]>);
    this.listeners.set(event, bucket);
    return () => this.off(event, listener);
  }

  off<Event extends keyof EventMap>(event: Event, listener: Listener<EventMap[Event]>): void {
    const bucket = this.listeners.get(event);
    if (!bucket) {
      return;
    }
    bucket.delete(listener as Listener<any[]>);
    if (!bucket.size) {
      this.listeners.delete(event);
    }
  }

  emit<Event extends keyof EventMap>(event: Event, ...args: EventMap[Event]): void {
    const bucket = this.listeners.get(event);
    if (!bucket) {
      return;
    }
    for (const handler of Array.from(bucket)) {
      handler(...args);
    }
  }

  clear(): void {
    this.listeners.clear();
  }
}

type NodeSocket = NodeWebSocket & WebSocketLike;
type BrowserSocket = WebSocket;

type SignalingCommandWire = {
  type: "signal";
  session_id?: string;
  to: string;
  payload: SignalingPayload;
};

export class SignalingChannel {
  readonly agentId: string;
  readonly expiresAt?: Date;
  readonly ready: Promise<void>;

  private readonly socket: WebSocketLike;
  private readonly emitter = new SimpleEventEmitter<SignalingChannelEventMap>();
  private readonly pendingFrames: string[] = [];
  private settledReady = false;
  private readonly detachFns: Array<() => void> = [];
  private isClosed = false;
  private resolveReady?: () => void;
  private rejectReady?: (error: Error) => void;

  constructor(agentId: string, socket: WebSocketLike, expiresAt?: Date) {
    this.agentId = agentId;
    this.socket = socket;
    this.expiresAt = expiresAt;
    this.ready = new Promise<void>((resolve, reject) => {
      this.resolveReady = () => {
        if (!this.settledReady) {
          this.settledReady = true;
          resolve();
        }
      };
      this.rejectReady = (error: Error) => {
        if (!this.settledReady) {
          this.settledReady = true;
          reject(error);
        }
      };
    });
    this.attachSocket();
  }

  on<Event extends keyof SignalingChannelEventMap>(
    event: Event,
    listener: Listener<SignalingChannelEventMap[Event]>
  ): () => void {
    return this.emitter.on(event, listener);
  }

  off<Event extends keyof SignalingChannelEventMap>(
    event: Event,
    listener: Listener<SignalingChannelEventMap[Event]>
  ): void {
    this.emitter.off(event, listener);
  }

  close(code?: number, reason?: string): void {
    if (this.isClosed) {
      return;
    }
    this.socket.close(code, reason);
  }

  sendQuicOffer(targetAgentId: string, offer: unknown): void {
    this.assertActive();
    this.sendCommand(
      {
        type: "signal",
        session_id: undefined,
        to: requireAgentId(targetAgentId),
        payload: { kind: "quic_offer", offer },
      },
      { requireSessionId: false }
    );
  }

  sendQuicAnswer(sessionId: string, targetAgentId: string, answer: unknown): void {
    this.assertActive();
    this.sendCommand({
      type: "signal",
      session_id: requireSessionId(sessionId),
      to: requireAgentId(targetAgentId),
      payload: { kind: "quic_answer", answer },
    });
  }

  sendQuicCandidate(sessionId: string, targetAgentId: string, candidate: unknown): void {
    this.assertActive();
    this.sendCommand({
      type: "signal",
      session_id: requireSessionId(sessionId),
      to: requireAgentId(targetAgentId),
      payload: { kind: "quic_candidate", candidate },
    });
  }

  disconnectSession(sessionId: string, targetAgentId: string, reason?: string): void {
    this.assertActive();
    this.sendCommand({
      type: "signal",
      session_id: requireSessionId(sessionId),
      to: requireAgentId(targetAgentId),
      payload: { kind: "disconnect", reason },
    });
  }

  private attachSocket(): void {
    if (isNodeSocket(this.socket)) {
      this.attachNodeSocket(this.socket as NodeSocket);
      return;
    }
    if (isBrowserSocket(this.socket)) {
      this.attachBrowserSocket(this.socket as BrowserSocket);
      return;
    }
    throw new Error("Unsupported WebSocket implementation");
  }

  private attachNodeSocket(socket: NodeSocket): void {
    const handleOpen = () => {
      this.resolveReady?.();
      this.emitter.emit("open");
      this.flushQueue();
    };
    const handleMessage = (data: RawData) => {
      this.handleMessagePayload(rawToString(data));
    };
    const handleError = (error: Error) => {
      if (this.isClosed || isTerminalSocketError(error)) {
        if (!this.isClosed && socket.readyState !== 1) {
          this.completeClose(undefined, error?.message);
        }
        return;
      }
      if (!this.settledReady) {
        this.rejectReady?.(error);
      }
      this.emitter.emit("error", error);
    };
    const handleClose = (code: number, reasonBuffer: Buffer) => {
      this.completeClose(code, bufferToString(reasonBuffer));
    };
    socket.on?.("open", handleOpen);
    socket.on?.("message", handleMessage);
    socket.on?.("error", handleError);
    socket.on?.("close", handleClose);
    this.detachFns.push(() => {
      socket.off?.("open", handleOpen);
      socket.off?.("message", handleMessage);
      socket.off?.("error", handleError);
      socket.off?.("close", handleClose);
      socket.removeListener?.("open", handleOpen);
      socket.removeListener?.("message", handleMessage);
      socket.removeListener?.("error", handleError);
      socket.removeListener?.("close", handleClose);
    });
  }

  private attachBrowserSocket(socket: BrowserSocket): void {
    const handleOpen = () => {
      this.resolveReady?.();
      this.emitter.emit("open");
      this.flushQueue();
    };
    const handleMessage = (event: MessageEvent) => {
      const data = typeof event.data === "string" ? event.data : String(event.data ?? "");
      this.handleMessagePayload(data);
    };
    const handleError = (event: Event) => {
      const error = event instanceof ErrorEvent ? event.error : new Error("websocket error");
      if (this.isClosed || isTerminalSocketError(error)) {
        if (!this.isClosed && socket.readyState !== 1) {
          this.completeClose(undefined, error?.message);
        }
        return;
      }
      if (!this.settledReady) {
        this.rejectReady?.(error);
      }
      this.emitter.emit("error", error);
    };
    const handleClose = (event: CloseEvent) => {
      this.completeClose(event.code, event.reason);
    };
    socket.addEventListener?.("open", handleOpen);
    socket.addEventListener?.("message", handleMessage as EventListener);
    socket.addEventListener?.("error", handleError as EventListener);
    socket.addEventListener?.("close", handleClose as EventListener);
    this.detachFns.push(() => {
      socket.removeEventListener?.("open", handleOpen);
      socket.removeEventListener?.("message", handleMessage as EventListener);
      socket.removeEventListener?.("error", handleError as EventListener);
      socket.removeEventListener?.("close", handleClose as EventListener);
    });
  }

  private handleMessagePayload(raw: string): void {
    if (!raw) {
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return;
    }
    const normalized = normalizeSocketEvent(parsed);
    if (!normalized) {
      return;
    }
    this.emitter.emit("raw", normalized);
    switch (normalized.type) {
      case "signaling":
        this.emitter.emit("signaling", normalized.payload);
        break;
      case "session":
        this.emitter.emit("session", normalized.payload);
        break;
      case "control":
        this.emitter.emit("control", normalized.payload);
        break;
      case "heartbeat":
        this.emitter.emit("heartbeat", normalized.payload);
        break;
      default:
        break;
    }
  }

  private sendCommand(command: SignalingCommandWire, options?: { requireSessionId?: boolean }): void {
    if (this.isClosed) {
      throw new Error("signaling channel already closed");
    }
    const requireSessionId = options?.requireSessionId ?? true;
    if (command.type === "signal" && requireSessionId && !command.session_id) {
      throw new Error("session_id is required for signaling commands");
    }
    const payload = JSON.stringify(command);
    if (this.socket.readyState === 1) {
      this.socket.send(payload);
    } else {
      this.pendingFrames.push(payload);
    }
  }

  private flushQueue(): void {
    if (this.socket.readyState !== 1 || !this.pendingFrames.length) {
      return;
    }
    while (this.pendingFrames.length) {
      const frame = this.pendingFrames.shift();
      if (frame) {
        this.socket.send(frame);
      }
    }
  }

  private completeClose(code?: number, reason?: string): void {
    if (this.isClosed) {
      return;
    }
    this.isClosed = true;
    for (const detach of this.detachFns) {
      try {
        detach();
      } catch {
        // ignore best-effort
      }
    }
    if (!this.settledReady) {
      this.rejectReady?.(new Error(`websocket closed (${code ?? 1000}) ${reason ?? ""}`.trim()));
    }
    this.emitter.emit("close", { code, reason });
    this.emitter.clear();
  }

  private assertActive(): void {
    if (this.isClosed) {
      throw new Error("signaling channel closed");
    }
  }
}

function normalizeSocketEvent(input: unknown): ParsedSocketEvent | null {
  if (!input || typeof input !== "object") {
    return null;
  }
  const { event, payload } = input as { event?: string; payload?: any };
  if (!event || !payload) {
    return null;
  }
  switch (event) {
    case "signaling":
      return { type: "signaling", payload: normalizeSignalingEvent(payload) };
    case "session":
      return { type: "session", payload: normalizeSessionEvent(payload) };
    case "control":
      return { type: "control", payload: normalizeControlEvent(payload) };
    case "heartbeat":
      return { type: "heartbeat", payload: normalizeHeartbeat(payload) };
    default:
      return null;
  }
}

function normalizeSignalingEvent(payload: any): SignalingEvent {
  return {
    sessionId: String(payload?.session_id ?? ""),
    from: String(payload?.from ?? ""),
    to: String(payload?.to ?? ""),
    expiresAt: toDate(payload?.expires_at),
    payload: normalizeSignalingPayload(payload?.payload),
  };
}

function normalizeSignalingPayload(payload: any): SignalingPayload {
  const rawKind = String(payload?.kind ?? payload?.type ?? "reject").toLowerCase();
  switch (rawKind) {
    case "quic_offer":
      return {
        kind: "quic_offer",
        offer: payload?.offer ?? payload?.payload ?? payload,
      };
    case "quic_answer":
      return {
        kind: "quic_answer",
        answer: payload?.answer ?? payload?.payload ?? payload,
      };
    case "quic_candidate":
      return {
        kind: "quic_candidate",
        candidate: payload?.candidate ?? payload?.payload ?? payload,
      };
    case "quic_relay":
      return {
        kind: "quic_relay",
        relay: payload?.relay ?? payload?.payload ?? payload,
      };
    case "disconnect":
      return { kind: "disconnect", reason: payload?.reason };
    default:
      return { kind: "reject", reason: payload?.reason ?? "unknown" };
  }
}

function normalizeSessionEvent(payload: any): SessionLifecycleEventPayload {
  return {
    sessionId: String(payload?.session_id ?? ""),
    targetAgent: String(payload?.target_agent ?? ""),
    peerAgent: String(payload?.peer_agent ?? ""),
    state: String(payload?.state ?? "pending") as SessionState,
    expiresAt: toDate(payload?.expires_at),
    reason: payload?.reason ?? undefined,
  };
}

function normalizeControlEvent(payload: any): ControlDirectiveEvent {
  return {
    targetAgent: String(payload?.target_agent ?? ""),
    action: String(payload?.action ?? "reject") as ControlAction,
    reason: String(payload?.reason ?? ""),
    sessionId: payload?.session_id ?? undefined,
  };
}

function normalizeHeartbeat(payload: any): HeartbeatBroadcast {
  return {
    agentId: String(payload?.agent_id ?? payload?.agentId ?? ""),
    timestamp: Number(payload?.timestamp ?? Date.now()),
    load: Number(payload?.load ?? 0),
    status: String(payload?.status ?? "online"),
  };
}

function toDate(value: unknown): Date {
  if (value instanceof Date) {
    return value;
  }
  if (typeof value === "string" || typeof value === "number") {
    const candidate = new Date(value);
    if (!Number.isNaN(candidate.getTime())) {
      return candidate;
    }
  }
  if (value && typeof (value as { toString?: () => string }).toString === "function") {
    const rendered = (value as { toString: () => string }).toString();
    const candidate = new Date(rendered);
    if (!Number.isNaN(candidate.getTime())) {
      return candidate;
    }
  }
  return new Date();
}

function rawToString(raw: RawData): string {
  if (typeof raw === "string") {
    return raw;
  }
  if (Buffer.isBuffer(raw)) {
    return raw.toString("utf8");
  }
  if (Array.isArray(raw)) {
    return Buffer.concat(raw).toString("utf8");
  }
  if ((raw as ArrayBufferLike)?.byteLength !== undefined) {
    return Buffer.from(raw as ArrayBufferLike).toString("utf8");
  }
  return String(raw ?? "");
}

function bufferToString(raw: Buffer): string {
  return raw?.length ? raw.toString("utf8") : "";
}

function isNodeSocket(socket: WebSocketLike): socket is NodeSocket {
  return typeof (socket as NodeSocket).on === "function";
}

function isBrowserSocket(socket: WebSocketLike): socket is BrowserSocket {
  return typeof (socket as BrowserSocket).addEventListener === "function";
}

function requireAgentId(value: string): string {
  const trimmed = String(value ?? "").trim();
  if (!trimmed) {
    throw new Error("target agent_id is required for signaling");
  }
  return trimmed;
}

function requireSessionId(value: string): string {
  const trimmed = String(value ?? "").trim();
  if (!trimmed) {
    throw new Error("session_id is required for signaling");
  }
  return trimmed;
}

function isTerminalSocketError(error: unknown): boolean {
  if (!error) {
    return false;
  }

  const message =
    typeof error === "string"
      ? error
      : error instanceof Error
      ? error.message
      : String((error as { message?: unknown })?.message ?? error);

  const normalized = message.toLowerCase();
  return (
    normalized.includes("connection closed") ||
    normalized.includes("websocket is not open") ||
    normalized.includes("already closed") ||
    normalized.includes("econnreset") ||
    normalized.includes("epipe") ||
    normalized.includes("ebadf")
  );
}