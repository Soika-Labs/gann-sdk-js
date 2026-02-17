# JS Multi-Agent Example (GANN + LangChain + OpenAI)

This folder contains two JavaScript/TypeScript apps:

- `general_chat_agent.ts` - chat agent that delegates image requests
- `image_generation_agent.ts` - image worker agent

The general chat agent validates payloads against the image agent schema using SDK methods:

- `fetchAgentSchema`
- `validateAgentInput`
- `validateAgentOutput`

## Setup

```bash
cd examples/js
cp .env.example .env
npm install
```

Set values in `.env`:

```env
OPENAI_API_KEY=sk-xxxx
GANN_API_KEY=gann_prod_xxx
GANN_BASE_URL=https://api.gnna.io
GENERAL_AGENT_ID=<uuid>
IMAGE_AGENT_ID=<uuid>
CHAT_MODEL=gpt-4o-mini
IMAGE_MODEL=dall-e-3
```

## Run

Terminal 1:

```bash
npm run image
```

Terminal 2:

```bash
npm run general
```

Type in chat terminal, for example:

- `hello`
- `generate an image of a futuristic city at sunset`

## Flow

1. General app connects with `connectAgent`.
2. Image app connects and waits with `acceptQuicDirectFirst`.
3. General app validates request payload against image agent input schema.
4. Payload is sent over negotiated GANN QUIC transport (direct when available, relay fallback otherwise).
5. Image app validates inbound payload, generates image, validates response payload.
6. General app validates response and prints image URL.
