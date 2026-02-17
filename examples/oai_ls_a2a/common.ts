import "dotenv/config";
import { GannClient } from "@soika/gann-sdk";

export type AppConfig = {
  apiKey: string;
  baseUrl: string;
  generalAgentId: string;
  imageAgentId: string;
  chatModel: string;
  imageModel: string;
};

export function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing environment variable: ${name}`);
  }
  return value;
}

export function loadConfig(): AppConfig {
  return {
    apiKey: process.env.GANN_API_KEY?.trim() || process.env["GANN-API-KEY"]?.trim() || requiredEnv("GANN_API_KEY"),
    baseUrl: process.env.GANN_BASE_URL?.trim() || "https://api.gnna.io",
    generalAgentId: requiredEnv("GENERAL_AGENT_ID"),
    imageAgentId: requiredEnv("IMAGE_AGENT_ID"),
    chatModel: process.env.CHAT_MODEL?.trim() || "gpt-4o-mini",
    imageModel: process.env.IMAGE_MODEL?.trim() || "dall-e-3",
  };
}

export function buildClient(config: AppConfig): GannClient {
  return new GannClient({
    apiKey: config.apiKey,
    baseUrl: config.baseUrl,
  });
}
