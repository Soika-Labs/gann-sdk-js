/// <reference types="node" />

export class PeerServer {
  static create(bindAddr: string): PeerServer;
  offer_json(advertised_candidates_json?: string | null): string;
  accept(): Promise<PeerConnection>;
  close(error_code: number, reason?: string | null): void;
}

export class PeerClient {
  static create(bindAddr: string): PeerClient;
  connect(offer_json: string): Promise<PeerConnection>;
}

export class PeerConnection {
  remote_address(): string;
  open_bi(): Promise<BiStream>;
  accept_bi(): Promise<BiStream>;
  close(error_code: number, reason?: string | null): void;
}

export class BiStream {
  write(data: Buffer): Promise<void>;
  finish(): Promise<void>;
  read(max_bytes?: number | null): Promise<Buffer | null>;
}

export class RelayClient {
  static create(bindAddr: string): RelayClient;
  connect_transport(relay_json: string): Promise<RelayTransport>;
}

export class RelayTransport {
  relay_bind(token: string, session_id: string): Promise<boolean>;
  relay_send(token: string, session_id: string, payload_json: string): Promise<void>;
  recv_relay_data(): Promise<string>;
  relay_send_e2ee(token: string, session_id: string, shared_key: Buffer, plaintext_json: string): Promise<void>;
  recv_relay_data_e2ee(shared_key: Buffer): Promise<string>;
  close(error_code: number, reason?: string | null): void;
}

export class E2eeKeyPairHandle {
  static generate(): E2eeKeyPairHandle;
  public_key_b64(): string;
  shared_key(peer_public_key_b64: string): Buffer;
}

export function encrypt_relay_payload(sharedKey: Buffer, sessionId: string, plaintextJson: string): string;
export function decrypt_relay_payload(sharedKey: Buffer, sessionId: string, payloadJson: string): string;
