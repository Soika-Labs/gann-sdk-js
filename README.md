# GANN JavaScript SDK (`@soika/gann-sdk`)

TypeScript-first SDK for the Global Agentic Neural Network (GANN): agent discovery,
schema validation, heartbeat/signaling, and QUIC direct-first sessions with relay fallback.

Published package: `@soika/gann-sdk`

## Compatibility

- Runtime: Node.js 18+
- Language: TypeScript / JavaScript (ESM)
- Core transport deps: native `fetch`, `ws`
- Optional QUIC native module: `@soika/gann-sdk-quic-native`

## Installation

Core SDK:

```bash
npm install @soika/gann-sdk
# or
pnpm add @soika/gann-sdk
```

With QUIC native support:

```bash
npm install @soika/gann-sdk @soika/gann-sdk-quic-native
# or
pnpm add @soika/gann-sdk @soika/gann-sdk-quic-native
```

## Environment variables

| Variable | Required | Description |
| --- | --- | --- |
| `GANN_API_KEY` | Yes (if not passed in constructor) | API key for all authenticated requests. |
| `GANN_BASE_URL` | No | GANN server URL. Defaults to `https://api.gnna.io`. |

> Request headers are sent as `GANN-API-KEY` and `GANN-AGENT-ID`.

## Core concepts

- `GannClient` is the main SDK class.
- `GannAgentClient` and `GannProxyClient` are aliases of `GannClient`.
- `LoadTracker` computes runtime load (`inFlight / capacity`) for heartbeats.
- `SignalingChannel` wraps websocket signaling (`quic_offer`, `quic_answer`, `quic_relay`, `disconnect`).
- QUIC session helpers choose:
  - `direct`: peer-to-peer QUIC stream
  - `relay`: server relay QUIC transport

## Quick start (search + schema)

```ts
import { GannClient } from "@soika/gann-sdk";

const client = new GannClient({
  apiKey: process.env.GANN_API_KEY,
  baseUrl: process.env.GANN_BASE_URL,
});

const result = await client.searchAgents({
  q: "image generation",
  status: "online",
  limit: 5,
});

console.log("agents found:", result.total);

if (result.agents.length > 0) {
  const schema = await client.fetchAgentSchema(result.agents[0].agent_id);
  console.log("schema agent:", schema.agent_id);
}
```

## Agent runtime lifecycle

```ts
import { GannClient, LoadTracker } from "@soika/gann-sdk";

const agentId = "00000000-0000-0000-0000-000000000000";

const client = new GannClient({
  apiKey: process.env.GANN_API_KEY,
  baseUrl: process.env.GANN_BASE_URL,
});

client.useLoadTracker(new LoadTracker(4));
await client.connectAgent(agentId, { heartbeatIntervalMs: 30_000 });

// ...app work...

client.disconnect();
```

## Schema validation helpers

```ts
import { GannClient, SchemaValidationError } from "@soika/gann-sdk";

const client = new GannClient({ apiKey: process.env.GANN_API_KEY });
const peerAgentId = "11111111-1111-1111-1111-111111111111";

const payload = {
  type: "image_generate_request",
  request_id: "req-1",
  prompt: "a futuristic city at sunset",
};

try {
  await client.validateAgentInput(peerAgentId, payload, { label: "peer.inputs" });
} catch (error) {
  if (error instanceof SchemaValidationError) {
    console.error("schema mismatch:", error.message);
  }
}
```

## Signaling usage

```ts
import { GannClient } from "@soika/gann-sdk";

const client = new GannClient({
  apiKey: process.env.GANN_API_KEY,
  agentId: process.env.GANN_AGENT_ID,
});

const channel = await client.connectSignaling();
await channel.ready;

channel.on("signaling", (event) => {
  console.log("kind:", event.payload.kind, "session:", event.sessionId);
});

channel.on("control", (event) => {
  console.log("control:", event.action, event.reason);
});

channel.on("heartbeat", (event) => {
  console.log("heartbeat from", event.agentId, "load", event.load);
});
```

## QUIC direct-first usage

Install QUIC native package first:

```bash
npm install @soika/gann-sdk-quic-native
```

### Initiator flow

```ts
import { GannClient } from "@soika/gann-sdk";

const client = new GannClient({
  apiKey: process.env.GANN_API_KEY,
  agentId: process.env.GANN_AGENT_ID,
});

const peerAgentId = process.env.GANN_PEER_AGENT_ID!;
const { channel, result } = await client.dialQuicDirectFirst(peerAgentId, {
  directTimeoutMs: 5000,
});

console.log("mode:", result.mode, "session:", result.sessionId);

if (result.mode === "direct") {
  const stream = await result.connection.openBi();
  await stream.write(Buffer.from(JSON.stringify({ type: "ping" })));
  await stream.finish();
} else {
  await result.transport.relaySend(result.token, result.sessionId, { type: "ping" });
}

channel.close();
client.disconnect();
```

### Responder flow

```ts
import { GannClient } from "@soika/gann-sdk";

const client = new GannClient({
  apiKey: process.env.GANN_API_KEY,
  agentId: process.env.GANN_AGENT_ID,
});

const { channel, result } = await client.acceptQuicDirectFirst({
  offerTimeoutMs: 30_000,
  directTimeoutMs: 5000,
});

console.log("mode:", result.mode, "session:", result.sessionId);

if (result.mode === "direct") {
  const stream = await result.connection.acceptBi();
  const data = await stream.read();
  console.log("direct bytes:", data?.toString("utf-8"));
} else {
  const frame = await result.transport.recvRelayData();
  console.log("relay payload:", frame.payload);
}

channel.close();
client.disconnect();
```

## Public API summary

Main exports:

- `GannClient`, `GannAgentClient`, `GannProxyClient`
- `LoadTracker`
- `SchemaValidationError`
- `SignalingChannel` + signaling event/types
- QUIC exports from `quic.ts` (`QuicPeerServer`, `QuicPeerClient`, `QuicPeerConnection`, `QuicRelayClient`, `QuicRelayTransport`, `E2eeKeyPair`, `encryptRelayPayload`, `decryptRelayPayload`)
- QUIC session exports from `quic_session.ts` (`initiateQuicSessionDirectFirst`, `respondQuicOfferDirectFirst`, options/result types)

Primary `GannClient` methods:

- `useAgent(agentId)`
- `useLoadTracker(tracker)`
- `fetchCapabilities()`
- `fetchIceConfig()`
- `heartbeat(...)`
- `searchAgents(...)`
- `fetchAgentSchema(agentId)`
- `validatePayloadAgainstSchema(...)`
- `validateAgentInput(...)`
- `validateAgentOutput(...)`
- `connectAgent(...)`
- `connectProxy(...)`
- `issueSignalingToken(...)`
- `connectSignaling(...)`
- `dialQuicDirectFirst(...)`
- `acceptQuicDirectFirst(...)`
- `disconnect()`

## Local development

```bash
npm install
npm run build
npm run lint
npm run test:full-flow
```

## Publishing to npm

Release order is important:

1. Publish native platform packages (`darwin-x64`, `linux-x64-gnu`, `win32-x64-msvc`).
2. Publish main native package (`@soika/gann-sdk-quic-native`).
3. Publish SDK package (`@soika/gann-sdk`).

### One-time setup

1. Configure GitHub Actions secret `NPM_TOKEN` with publish access.
2. Keep versions aligned:
  - `native/package.json`
  - `native/npm/*/package.json`
  - root `package.json` (when publishing SDK)

### CI release (recommended)

1. Run workflow `Publish Native to npm`.
2. After native publish succeeds, run workflow `Publish SDK to npm`.

Optional validation workflow: `Native Cross Build` (build-only matrix).

### Local commands

Build/check SDK:

```bash
npm ci
npm run build
npm pack --dry-run
```

Build/check native package on current OS:

```bash
npm --prefix native ci
npm run prepare:native:npm
```

Publish native platform package on current OS:

```bash
npm --prefix native run publish:platform
```

Publish main native package:

```bash
npm --prefix native run publish:package
```

Publish SDK package:

```bash
npm run publish:sdk:npm
```

## Related examples

See `../../examples/python` for cross-agent orchestration examples using the same GANN transport patterns.
