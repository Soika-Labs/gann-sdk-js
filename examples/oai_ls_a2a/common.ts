import "dotenv/config";
import { GannClient } from "@soika/gann-sdk";

export type AppConfig = {
  apiKey: string;
  baseUrl: string;
  generalAgentId: string;
  imageAgentId: string;
  chatModel: string;
  imageModel: string;
  quicDirectBindAddr: string;
  quicStunServers: string[];
  quicAdvertisedCandidates: string[];
};

function splitCsv(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

export function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing environment variable: ${name}`);
  }
  return value;
}

export function loadConfig(): AppConfig {
  const quicStunServers = splitCsv(process.env.QUIC_STUN_SERVERS) || [];
  return {
    apiKey: process.env.GANN_API_KEY?.trim() || process.env["GANN-API-KEY"]?.trim() || requiredEnv("GANN_API_KEY"),
    baseUrl: process.env.GANN_BASE_URL?.trim() || "https://api.gnna.io",
    generalAgentId: requiredEnv("GENERAL_AGENT_ID"),
    imageAgentId: requiredEnv("IMAGE_AGENT_ID"),
    chatModel: process.env.CHAT_MODEL?.trim() || "gpt-4o-mini",
    imageModel: process.env.IMAGE_MODEL?.trim() || "dall-e-3",
    quicDirectBindAddr: process.env.QUIC_DIRECT_BIND_ADDR?.trim() || "0.0.0.0:0",
    quicStunServers:
      quicStunServers.length > 0
        ? quicStunServers
        : ["stun:stun.l.google.com:19302", "stun:stun.cloudflare.com:3478"],
    quicAdvertisedCandidates: splitCsv(process.env.QUIC_ADVERTISED_CANDIDATES),
  };
}

export function buildClient(config: AppConfig): GannClient {
  return new GannClient({
    apiKey: config.apiKey,
    baseUrl: config.baseUrl,
  });
}
