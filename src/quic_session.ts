import type { SignalingChannel, SignalingEvent } from "./signaling.js";
import {
  QuicPeerClient,
  QuicPeerServer,
  QuicRelayClient,
  type QuicOffer,
  type QuicRelayInfo,
  type QuicRelayTransport,
} from "./quic.js";

export type QuicSessionMode = "direct" | "relay";

export type QuicDirectFirstOptions = {
  directTimeoutMs?: number;
  directBindAddr?: string;
  relayBindAddr?: string;
  advertisedCandidates?: string[];

  /** Token returned by `/.gann/ws/token` (same token used for signaling). */
  token: string;
};

export type QuicDirectFirstResult =
  | {
      mode: "direct";
      sessionId: string;
      peerAgentId: string;
      connection: Awaited<ReturnType<QuicPeerClient["connect"]>>;
    }
  | {
      mode: "relay";
      sessionId: string;
      peerAgentId: string;
      relay: QuicRelayInfo;
      transport: QuicRelayTransport;
      peerReady: boolean;
      token: string;
    };

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  if (timeoutMs <= 0) {
    return promise;
  }
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<T>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Timed out (${label})`)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => timer && clearTimeout(timer));
}

function isRelayPayload(event: SignalingEvent): event is SignalingEvent & { payload: { kind: "quic_relay"; relay: unknown } } {
  return event.payload?.kind === "quic_relay";
}

function isAnswerPayload(event: SignalingEvent): event is SignalingEvent & { payload: { kind: "quic_answer"; answer: any } } {
  return event.payload?.kind === "quic_answer";
}

function isOfferPayload(event: SignalingEvent): event is SignalingEvent & { payload: { kind: "quic_offer"; offer: unknown } } {
  return event.payload?.kind === "quic_offer";
}

function parseRelayInfo(raw: unknown): QuicRelayInfo {
  if (!raw || typeof raw !== "object") {
    throw new Error("Invalid quic_relay payload");
  }
  const value = raw as any;
  const session_id = String(value.session_id ?? "").trim();
  const quic_addr = String(value.quic_addr ?? "").trim();
  const server_fingerprint_sha256 = String(value.server_fingerprint_sha256 ?? "").trim();
  if (!session_id || !quic_addr || !server_fingerprint_sha256) {
    throw new Error("Invalid quic_relay payload fields");
  }
  return {
    session_id,
    quic_addr,
    server_fingerprint_sha256,
    alpn: value.alpn ?? undefined,
    server_name: value.server_name ?? undefined,
  };
}

async function waitForSessionEvent(
  channel: SignalingChannel,
  predicate: (event: SignalingEvent) => boolean,
  timeoutMs: number,
): Promise<SignalingEvent> {
  return new Promise<SignalingEvent>((resolve, reject) => {
    let timer: NodeJS.Timeout | undefined;

    const off = channel.on("signaling", (event) => {
      try {
        if (!predicate(event)) {
          return;
        }
        cleanup();
        resolve(event);
      } catch (err) {
        cleanup();
        reject(err);
      }
    });

    const onError = channel.on("error", (err) => {
      cleanup();
      reject(err);
    });

    const onClose = channel.on("close", ({ code, reason }) => {
      cleanup();
      reject(new Error(`Signaling channel closed (${code ?? "?"}): ${reason ?? ""}`));
    });

    const cleanup = () => {
      off();
      onError();
      onClose();
      if (timer) {
        clearTimeout(timer);
        timer = undefined;
      }
    };

    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        cleanup();
        reject(new Error("Timed out waiting for signaling event"));
      }, timeoutMs);
    }
  });
}

/**
 * Initiator flow:
 * - start a local QUIC peer server
 * - send a QUIC offer via signaling
 * - wait for direct inbound connect (preferred) or timeout => relay
 */
export async function initiateQuicSessionDirectFirst(
  channel: SignalingChannel,
  peerAgentId: string,
  options: QuicDirectFirstOptions,
): Promise<QuicDirectFirstResult> {
  const directTimeoutMs = options.directTimeoutMs ?? 5000;
  const directBindAddr = options.directBindAddr ?? "0.0.0.0:0";
  const relayBindAddr = options.relayBindAddr ?? "0.0.0.0:0";

  const server = QuicPeerServer.create(directBindAddr);
  const offer: QuicOffer = server.offer(options.advertisedCandidates);

  channel.sendQuicOffer(peerAgentId, offer);

  const acceptPromise = withTimeout(server.accept(), directTimeoutMs, "direct QUIC accept");

  // Relay info arrives even when direct is possible; capture it for fallback.
  const relayEventPromise = waitForSessionEvent(
    channel,
    (ev) => ev.from === peerAgentId && isRelayPayload(ev),
    Math.max(2000, directTimeoutMs),
  ).then((ev) => ({ sessionId: ev.sessionId, relay: parseRelayInfo((ev as any).payload.relay) }));

  try {
    const connection = await acceptPromise;

    // We still want the session id for later bookkeeping; relayEvent will have it.
    const relayEvent = await withTimeout(relayEventPromise, 2000, "session id");

    return {
      mode: "direct",
      sessionId: relayEvent.sessionId,
      peerAgentId,
      connection,
    };
  } catch {
    // direct failed => relay
  }

  const relayEvent = await relayEventPromise;
  const relayClient = QuicRelayClient.create(relayBindAddr);
  const transport = await relayClient.connectTransport(relayEvent.relay);
  let peerReady = await transport.relayBind(options.token, relayEvent.sessionId);

  if (!peerReady) {
    const deadline = Date.now() + Math.max(2000, directTimeoutMs);
    while (!peerReady && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      peerReady = await transport.relayBind(options.token, relayEvent.sessionId);
    }
  }

  return {
    mode: "relay",
    sessionId: relayEvent.sessionId,
    peerAgentId,
    relay: relayEvent.relay,
    transport,
    peerReady,
    token: options.token,
  };
}

/**
 * Responder flow:
 * - given an inbound `quic_offer` event, attempt direct connect first
 * - on failure, fall back to relay using the session's `quic_relay` info
 */
export async function respondQuicOfferDirectFirst(
  channel: SignalingChannel,
  offerEvent: SignalingEvent,
  options: QuicDirectFirstOptions,
  relayEvent?: SignalingEvent,
): Promise<QuicDirectFirstResult> {
  if (!isOfferPayload(offerEvent)) {
    throw new Error("offerEvent must have quic_offer payload");
  }

  const directTimeoutMs = options.directTimeoutMs ?? 5000;
  const directBindAddr = options.directBindAddr ?? "0.0.0.0:0";
  const relayBindAddr = options.relayBindAddr ?? "0.0.0.0:0";

  const peerAgentId = offerEvent.from;
  const sessionId = offerEvent.sessionId;
  const offer = offerEvent.payload.offer as QuicOffer;
  const relayTimeoutMs = Math.max(10_000, directTimeoutMs * 5);

  const relayEventPromise: Promise<SignalingEvent> =
    relayEvent && isRelayPayload(relayEvent) && relayEvent.sessionId === sessionId
      ? Promise.resolve(relayEvent)
      : waitForSessionEvent(
          channel,
          (ev) => ev.sessionId === sessionId && isRelayPayload(ev),
          relayTimeoutMs,
        );

  const client = QuicPeerClient.create(directBindAddr);
  try {
    const connection = await withTimeout(client.connect(offer), directTimeoutMs, "direct QUIC connect");
    channel.sendQuicAnswer(sessionId, peerAgentId, { accepted: true, mode: "direct" });
    return {
      mode: "direct",
      sessionId,
      peerAgentId,
      connection,
    };
  } catch {
    // fall through to relay
  }

  const effectiveRelayEvent = await relayEventPromise;

  const relay = parseRelayInfo((effectiveRelayEvent as any).payload.relay);
  const relayClient = QuicRelayClient.create(relayBindAddr);
  const transport = await relayClient.connectTransport(relay);
  let peerReady = await transport.relayBind(options.token, sessionId);

  if (!peerReady) {
    const deadline = Date.now() + Math.max(2000, directTimeoutMs);
    while (!peerReady && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      peerReady = await transport.relayBind(options.token, sessionId);
    }
  }

  channel.sendQuicAnswer(sessionId, peerAgentId, { accepted: true, mode: "relay" });

  return {
    mode: "relay",
    sessionId,
    peerAgentId,
    relay,
    transport,
    peerReady,
    token: options.token,
  };
}
