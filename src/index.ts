import NodeWebSocket, { ClientOptions as WsClientOptions } from "ws";
import {
  SignalingChannel,
  type SignalingConnectOptions,
  type SignalingEvent,
  type SignalingSocketOptions,
  type SignalingToken,
} from "./signaling.js";

import {
  initiateQuicSessionDirectFirst,
  respondQuicOfferDirectFirst,
  type QuicDirectFirstOptions,
  type QuicDirectFirstResult,
} from "./quic_session.js";

export * from "./quic.js";
export * from "./quic_session.js";

export type CapabilityDescriptor = {
  name: string;
  description?: string;
};

export type AgentStatus = "online" | "offline" | "degraded" | "blocked";
export type AgentType = string & {};

export type AgentDetails = {
  agent_id: string;
  agent_name: string;
  capabilities: CapabilityDescriptor[];
  inputs?: Record<string, unknown> | null;
  outputs?: Record<string, unknown> | null;
  status: AgentStatus;
  search_score?: number;
};

export type IceServer = {
  urls: string[];
  username?: string | null;
  credential?: string | null;
};

export type IceConfigResponse = {
  ice_servers: IceServer[];
};

export type AgentSearchResponse = {
  total: number;
  agents: AgentDetails[];
};

export type AgentSchemaResponse = {
  agent_id: string;
  inputs?: Record<string, unknown> | null;
  outputs?: Record<string, unknown> | null;
};

export class SchemaValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SchemaValidationError";
  }
}

export type AgentSearchParams = {
  q?: string;
  status?: AgentStatus;
  whitelist?: string[];
  blacklist?: string[];
  min_cost?: number;
  max_cost?: number;
  [key: string]: unknown;
};

const GAN_HEADERS = {
  agentId: "GANN-AGENT-ID",
  apiKey: "GANN-API-KEY",
};

const DEFAULT_BASE_URL = "https://api.gnna.io";

function envValue(key: string): string | undefined {
  if (typeof process === "undefined" || !process?.env) {
    return undefined;
  }
  const value = process.env[key];
  return value && value.trim() ? value.trim() : undefined;
}

function resolveBaseUrl(value?: string): string {
  const chosen = value?.trim() || envValue("GANN_BASE_URL") || DEFAULT_BASE_URL;
  return chosen.replace(/\/$/, "");
}

function resolveApiKey(explicit: string | undefined, envKeys: string[]): string {
  if (explicit?.trim()) {
    return explicit.trim();
  }
  for (const key of envKeys) {
    const env = envValue(key);
    if (env) {
      return env;
    }
  }
  throw new Error(`GANN API key missing; set one of ${envKeys.join(", ")}`);
}
export interface AgentClientOptions {
  baseUrl?: string;
  apiKey?: string;
  agentId?: string;
}

export interface ProxyClientOptions extends AgentClientOptions {
  proxySourceAgentId: string;
}

export type QuicDirectFirstClientOptions = Omit<QuicDirectFirstOptions, "token">;

export type QuicDirectFirstAcceptOptions = QuicDirectFirstClientOptions & {
  offerTimeoutMs?: number;
};

export type QuicDirectFirstSessionHandle = {
  channel: SignalingChannel;
  token: string;
  result: QuicDirectFirstResult;
};

export class LoadTracker {
  private inFlight = 0;
  private readonly capacity: number;

  constructor(capacity: number = 1) {
    this.capacity = Math.max(1, Math.floor(capacity));
  }

  begin(): () => void {
    this.inFlight += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.inFlight = Math.max(0, this.inFlight - 1);
    };
  }

  async track<T>(work: Promise<T>): Promise<T> {
    const release = this.begin();
    try {
      return await work;
    } finally {
      release();
    }
  }

  getInFlight(): number {
    return this.inFlight;
  }

  getCapacity(): number {
    return this.capacity;
  }

  load(): number {
    return Math.max(0, Math.min(1, this.inFlight / this.capacity));
  }
}

export class GannClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private agentId?: string;
  private proxySourceAgentId?: string;
  private loadTracker?: LoadTracker;
  private heartbeatInterval: number = 30000;
  private heartbeatTimerId?: NodeJS.Timeout;
  private signalingChannel?: SignalingChannel;

  constructor(options: AgentClientOptions) {
    this.baseUrl = resolveBaseUrl(options.baseUrl);
    this.apiKey = resolveApiKey(options.apiKey, ["GANN_API_KEY"]);
    this.agentId = options.agentId;
  }

  useAgent(agentId: string): void {
    this.agentId = agentId;
  }

  useLoadTracker(tracker: LoadTracker): void {
    this.loadTracker = tracker;
  }

  async fetchCapabilities(): Promise<Record<string, unknown>> {
    return this.request("GET", "/.gann/capabilities", undefined, this.agentHeaders());
  }

  async fetchIceConfig(): Promise<IceConfigResponse> {
    return this.request<IceConfigResponse>("GET", "/.gann/ice/config", undefined, this.agentHeaders());
  }

  async heartbeat(payload: { load?: number; status?: string } = {}): Promise<Record<string, unknown>> {
    const body = {
      agent_id: this.requireAgentId(),
      timestamp: Math.floor(Date.now() / 1000),
      load: payload.load ?? this.loadTracker?.load() ?? 0,
      status: payload.status ?? "online",
    };
    return this.request("POST", "/.gann/heartbeat", body, this.agentHeaders());
  }

  async searchAgents(params: {
    q: string;
    status?: AgentStatus;
    whitelist?: string[];
    blacklist?: string[];
    min_cost?: number;
    limit?: number;
    offset?: number;
  }): Promise<AgentSearchResponse> {
    const query: Record<string, unknown> = { q: params.q };
    if (params.status) query.status = params.status;
    if (params.whitelist) query.whitelist = params.whitelist;
    if (params.blacklist) query.blacklist = params.blacklist;
    if (params.min_cost !== undefined) query.min_cost = params.min_cost;
    query.limit = params.limit ?? 50;
    query.offset = params.offset ?? 0;

    return this.request<AgentSearchResponse>(
      "GET",
      "/.gann/agents/search",
      undefined,
      this.apiHeaders(),
      query
    );
  }

  async connectAgent(
    agentId: string,
    options: {
      heartbeatIntervalMs?: number;
      onSignal?: (event: SignalingEvent) => void;
      onError?: (error: Error) => void;
    } = {},
  ): Promise<GannClient> {
    this.agentId = agentId;
    this.proxySourceAgentId = undefined;
    this.heartbeatInterval = options.heartbeatIntervalMs ?? 30000;

    this.startHeartbeatLoop();

    try {
      this.signalingChannel = await this.connectSignaling();
      if (options.onSignal) {
        this.signalingChannel.on("signaling", options.onSignal);
      }
      if (options.onError) {
        this.signalingChannel.on("error", options.onError);
      }
    } catch (error) {
      if (options.onError) {
        options.onError(error instanceof Error ? error : new Error(String(error)));
      }
      throw error;
    }

    return this;
  }

  async connectProxy(
    proxySourceAgentId: string,
    appAgentId: string,
    options: {
      heartbeatIntervalMs?: number;
      onSignal?: (event: SignalingEvent) => void;
      onError?: (error: Error) => void;
    } = {},
  ): Promise<AgentDetails> {
    this.agentId = appAgentId;
    this.proxySourceAgentId = proxySourceAgentId;
    this.heartbeatInterval = options.heartbeatIntervalMs ?? 30000;

    // Fetch source agent details
    const sourceAgent = await this.getAgent(proxySourceAgentId);
    if (!sourceAgent) {
      throw new Error(`Agent ${proxySourceAgentId} not found`);
    }

    this.startHeartbeatLoop();

    try {
      this.signalingChannel = await this.connectSignaling();
      if (options.onSignal) {
        this.signalingChannel.on("signaling", options.onSignal);
      }
      if (options.onError) {
        this.signalingChannel.on("error", options.onError);
      }
    } catch (error) {
      if (options.onError) {
        options.onError(error instanceof Error ? error : new Error(String(error)));
      }
      throw error;
    }

    return sourceAgent;
  }

  async fetchAgentSchema(agentId: string): Promise<AgentSchemaResponse> {
    return this.request<AgentSchemaResponse>(
      "GET",
      `/.gann/agents/${agentId}/schema`,
      undefined,
      this.apiHeaders(),
    );
  }

  validatePayloadAgainstSchema(
    payload: Record<string, unknown>,
    schema: Record<string, unknown> | null | undefined,
    options: { label?: string; capability?: string } = {},
  ): void {
    const label = options.label ?? "payload";
    const candidate = resolveSchemaCandidate(schema, options.capability);
    if (!candidate) {
      throw new SchemaValidationError(`${label}: schema is missing`);
    }
    validateAgainstSchema(payload, candidate, label);
  }

  async validateAgentInput(
    agentId: string,
    payload: Record<string, unknown>,
    options: { label?: string; capability?: string } = {},
  ): Promise<AgentSchemaResponse> {
    const schema = await this.fetchAgentSchema(agentId);
    this.validatePayloadAgainstSchema(payload, schema.inputs ?? undefined, {
      label: options.label ?? "agent.inputs",
      capability: options.capability,
    });
    return schema;
  }

  async validateAgentOutput(
    agentId: string,
    payload: Record<string, unknown>,
    options: { label?: string; capability?: string } = {},
  ): Promise<AgentSchemaResponse> {
    const schema = await this.fetchAgentSchema(agentId);
    this.validatePayloadAgainstSchema(payload, schema.outputs ?? undefined, {
      label: options.label ?? "agent.outputs",
      capability: options.capability,
    });
    return schema;
  }

  disconnect(): void {
    if (this.heartbeatTimerId) {
      clearInterval(this.heartbeatTimerId);
      this.heartbeatTimerId = undefined;
    }
    if (this.signalingChannel) {
      this.signalingChannel.close(1000, "disconnecting");
    }
  }

  async issueSignalingToken(agentId?: string): Promise<SignalingToken> {
    const target = agentId ?? this.requireAgentId();
    const response = await this.request<{ token: string; expires_at: string }>(
      "POST",
      "/.gann/ws/token",
      undefined,
      this.agentHeaders(target)
    );
    const token = response?.token?.trim();
    const expires = response?.expires_at;
    if (!token || !expires) {
      throw new Error("GANN server response missing websocket token");
    }
    const expiresDate = new Date(expires);
    if (Number.isNaN(expiresDate.getTime())) {
      throw new Error("GANN server returned invalid websocket token expiry");
    }
    return {
      token,
      rawExpiresAt: expires,
      expiresAt: expiresDate,
    };
  }

  async connectSignaling(options: Partial<SignalingConnectOptions> = {}): Promise<SignalingChannel> {
    const agentId = options.agentId ?? this.requireAgentId();
    let token = options.token?.trim();
    let expiresAt: Date | undefined = options.expiresAt;
    if (!token) {
      const issued = await this.issueSignalingToken(agentId);
      token = issued.token;
      expiresAt = issued.expiresAt;
    }
    if (!token) {
      throw new Error("signaling token required to open websocket");
    }
    const url = this.signalingWebsocketUrl(token);
    const factory =
      options.webSocketFactory ??
      ((socketUrl: string, wsOptions?: SignalingSocketOptions) => {
        if (typeof wsOptions === "string" || Array.isArray(wsOptions)) {
          return new NodeWebSocket(socketUrl, wsOptions);
        }
        if (wsOptions) {
          return new NodeWebSocket(socketUrl, wsOptions);
        }
        return new NodeWebSocket(socketUrl);
      });
    const socket = factory(url, options.wsOptions);
    return new SignalingChannel(agentId, socket, expiresAt);
  }

  async dialQuicDirectFirst(
    peerAgentId: string,
    options: QuicDirectFirstClientOptions = {},
  ): Promise<QuicDirectFirstSessionHandle> {
    const agentId = this.requireAgentId();
    const issued = await this.issueSignalingToken(agentId);
    const channel = await this.connectSignaling({ agentId, token: issued.token, expiresAt: issued.expiresAt });

    const result = await initiateQuicSessionDirectFirst(channel, peerAgentId, {
      ...options,
      token: issued.token,
    });

    return { channel, token: issued.token, result };
  }

  async acceptQuicDirectFirst(
    options: QuicDirectFirstAcceptOptions = {},
  ): Promise<QuicDirectFirstSessionHandle> {
    const { offerTimeoutMs = 30_000, ...directOptions } = options;
    const agentId = this.requireAgentId();
    const issued = await this.issueSignalingToken(agentId);
    const channel = this.signalingChannel
      ? this.signalingChannel
      : await this.connectSignaling({ agentId, token: issued.token, expiresAt: issued.expiresAt });

    if (!this.signalingChannel) {
      this.signalingChannel = channel;
    }

    const { offerEvent, relayEvent } = await new Promise<{
      offerEvent: SignalingEvent;
      relayEvent?: SignalingEvent;
    }>((resolve, reject) => {
      let timer: NodeJS.Timeout | undefined;
      const relayBySession = new Map<string, SignalingEvent>();

      const offSignaling = channel.on("signaling", (event) => {
        if (event.payload?.kind === "quic_relay" && event.sessionId) {
          relayBySession.set(event.sessionId, event);
        }
        if (event.payload?.kind !== "quic_offer") {
          return;
        }
        const cachedRelay = relayBySession.get(event.sessionId);
        cleanup();
        resolve({ offerEvent: event, relayEvent: cachedRelay });
      });

      const offError = channel.on("error", (err) => {
        cleanup();
        reject(err);
      });

      const offClose = channel.on("close", ({ code, reason }) => {
        cleanup();
        reject(new Error(`Signaling channel closed (${code ?? "?"}): ${reason ?? ""}`));
      });

      const cleanup = () => {
        offSignaling();
        offError();
        offClose();
        if (timer) {
          clearTimeout(timer);
          timer = undefined;
        }
      };

      if (offerTimeoutMs > 0) {
        timer = setTimeout(() => {
          cleanup();
          reject(new Error("Timed out waiting for quic_offer"));
        }, offerTimeoutMs);
      }
    });

    const result = await respondQuicOfferDirectFirst(channel, offerEvent, {
      ...directOptions,
      token: issued.token,
    }, relayEvent);

    return { channel, token: issued.token, result };
  }

  private startHeartbeatLoop(): void {
    if (this.heartbeatTimerId) {
      clearInterval(this.heartbeatTimerId);
    }
    this.heartbeatTimerId = setInterval(() => {
      this.heartbeat().catch(() => {
        // Silently ignore heartbeat errors
      });
    }, this.heartbeatInterval);
  }

  private async getAgent(agentId: string): Promise<AgentDetails | undefined> {
    const url = `${this.baseUrl}/.gann/agents/${agentId}`;
    const response = await fetch(url, {
      method: "GET",
      headers: this.apiHeaders(),
    });
    if (response.status === 404) {
      return undefined;
    }
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`GANN request failed (${response.status}): ${text}`);
    }
    return (await response.json()) as AgentDetails;
  }

  private apiHeaders(): Record<string, string> {
    return { [GAN_HEADERS.apiKey]: this.apiKey };
  }

  private agentHeaders(agentId?: string): Record<string, string> {
    const target = agentId ?? this.requireAgentId();
    return {
      ...this.apiHeaders(),
      [GAN_HEADERS.agentId]: target,
    };
  }

  private async request<T = Record<string, any>>(
    method: string,
    path: string,
    body?: Record<string, unknown>,
    headers: Record<string, string> = {},
    query?: Record<string, unknown>
  ): Promise<T> {
    const url = new URL(`${this.baseUrl}${path}`);
    if (query) {
      for (const [key, value] of Object.entries(query)) {
        if (value === undefined || value === null) continue;
        if (Array.isArray(value)) {
          value.forEach((entry) => url.searchParams.append(key, String(entry)));
        } else {
          url.searchParams.set(key, String(value));
        }
      }
    }
    const requestHeaders: Record<string, string> = { ...headers };
    if (body) {
      requestHeaders["Content-Type"] = "application/json";
    }
    const response = await fetch(url, {
      method,
      headers: requestHeaders,
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`GANN request failed (${response.status}): ${text}`);
    }
    if (response.status === 204) {
      return {} as T;
    }
    return response.json() as Promise<T>;
  }

  private requireAgentId(): string {
    if (!this.agentId) throw new Error("agent_id not set; call connectAgent or connectProxy first");
    return this.agentId;
  }

  private signalingWebsocketUrl(token: string): string {
    const base = this.websocketUrl();
    const separator = base.includes("?") ? "&" : "?";
    return `${base}${separator}token=${encodeURIComponent(token)}`;
  }

  private websocketUrl(): string {
    if (this.baseUrl.startsWith("https://")) {
      return `wss://${this.baseUrl.slice("https://".length)}/.gann/ws`;
    }
    if (this.baseUrl.startsWith("http://")) {
      return `ws://${this.baseUrl.slice("http://".length)}/.gann/ws`;
    }
    return `ws://${this.baseUrl}/.gann/ws`;
  }
}

function resolveSchemaCandidate(
  schema: Record<string, unknown> | null | undefined,
  capability?: string,
): Record<string, unknown> | undefined {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
    return undefined;
  }

  if (looksLikeJsonSchema(schema)) {
    return schema;
  }

  if (capability) {
    const scoped = schema[capability];
    if (scoped && typeof scoped === "object" && !Array.isArray(scoped)) {
      return scoped as Record<string, unknown>;
    }
  }

  const keys = Object.keys(schema);
  if (keys.length === 1) {
    const only = schema[keys[0]];
    if (only && typeof only === "object" && !Array.isArray(only)) {
      return only as Record<string, unknown>;
    }
  }

  return undefined;
}

function looksLikeJsonSchema(schema: Record<string, unknown>): boolean {
  return ["type", "properties", "required", "const", "enum"].some((key) => key in schema);
}

function validateAgainstSchema(
  payload: Record<string, unknown>,
  schema: Record<string, unknown>,
  label: string,
): void {
  const declaredType = schema.type;
  if (declaredType !== undefined && !matchesType(payload, declaredType)) {
    throw new SchemaValidationError(`${label}: payload type does not match schema type=${String(declaredType)}`);
  }

  const required = schema.required;
  if (Array.isArray(required)) {
    const missing = required
      .filter((field) => typeof field === "string")
      .filter((field) => !(field in payload));
    if (missing.length > 0) {
      throw new SchemaValidationError(`${label}: missing required fields: ${missing.join(", ")}`);
    }
  }

  const properties = schema.properties;
  if (properties && typeof properties === "object" && !Array.isArray(properties)) {
    for (const [key, propertySchema] of Object.entries(properties)) {
      if (!(key in payload)) continue;
      validateProperty(payload[key], propertySchema, `${label}.${key}`);
    }

    if (schema.additionalProperties === false) {
      const extras = Object.keys(payload).filter((key) => !(key in properties));
      if (extras.length > 0) {
        throw new SchemaValidationError(`${label}: unexpected fields: ${extras.join(", ")}`);
      }
    }
  }
}

function validateProperty(value: unknown, schema: unknown, path: string): void {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
    return;
  }
  const typed = schema as Record<string, unknown>;

  if ("const" in typed && value !== typed.const) {
    throw new SchemaValidationError(`${path}: expected const=${JSON.stringify(typed.const)}, got ${JSON.stringify(value)}`);
  }

  if (Array.isArray(typed.enum) && !typed.enum.includes(value)) {
    throw new SchemaValidationError(`${path}: value not in enum ${JSON.stringify(typed.enum)}`);
  }

  if (typed.type !== undefined && !matchesType(value, typed.type)) {
    throw new SchemaValidationError(`${path}: type mismatch; expected ${String(typed.type)}`);
  }

  if (typed.format === "uri" && value != null) {
    if (typeof value !== "string" || (!value.startsWith("http://") && !value.startsWith("https://"))) {
      throw new SchemaValidationError(`${path}: expected URI string`);
    }
  }
}

function matchesType(value: unknown, expected: unknown): boolean {
  if (Array.isArray(expected)) {
    return expected.some((item) => matchesType(value, item));
  }
  switch (expected) {
    case "null":
      return value === null;
    case "string":
      return typeof value === "string";
    case "boolean":
      return typeof value === "boolean";
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "number":
      return typeof value === "number";
    case "object":
      return value !== null && typeof value === "object" && !Array.isArray(value);
    case "array":
      return Array.isArray(value);
    default:
      return true;
  }
}

// Backwards compatibility
export const GannAgentClient = GannClient;
export const GannProxyClient = GannClient;
export { SignalingChannel } from "./signaling.js";
export type {
  SignalingConnectOptions,
  SignalingSocketOptions,
  SignalingToken,
  SignalingPayload,
  SignalingEvent,
  SessionLifecycleEventPayload,
  ControlDirectiveEvent,
  HeartbeatBroadcast,
  ParsedSocketEvent,
  SignalingChannelEventMap,
  WebSocketFactory,
  WebSocketLike,
} from "./signaling.js";