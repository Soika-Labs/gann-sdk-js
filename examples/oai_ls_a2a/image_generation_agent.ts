import OpenAI from "openai";
import { ChatOpenAI } from "@langchain/openai";

import { buildClient, loadConfig } from "./common.js";

class ImageGenerationAgentApp {
  private readonly config = loadConfig();
  private readonly client = buildClient(this.config);
  private readonly refiner = new ChatOpenAI({ model: this.config.chatModel, temperature: 0.2 });
  private readonly openai = new OpenAI();

  async start(): Promise<void> {
    console.log("[image-js] connecting to GANN...");
    await this.client.connectAgent(this.config.imageAgentId, {
      onError: (err: Error) => console.error("[image-js] error:", err.message),
    });
    await this.client.fetchAgentSchema(this.config.imageAgentId);
    console.log(`[image-js] online as ${this.config.imageAgentId}`);

    for (;;) {
      try {
        await this.acceptOneSession();
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (message.toLowerCase().includes("timed out waiting for quic_offer")) {
          console.log("[image-js] no offer received before timeout; listening again");
          continue;
        }
        console.log(`[image-js] session error: ${message}`);
      }
    }
  }

  private async acceptOneSession(): Promise<void> {
    const handle = await this.client.acceptQuicDirectFirst({
      directTimeoutMs: 3_000,
      offerTimeoutMs: 300_000,
    });
    console.log(`[image-js] session accepted mode=${handle.result.mode} session=${handle.result.sessionId}`);

    try {
      let payload: Record<string, unknown>;
      let directStream: any;

      if (handle.result.mode === "relay") {
        const frame = await handle.result.transport.recvRelayData();
        payload = frame.payload as Record<string, unknown>;
      } else {
        directStream = await handle.result.connection.acceptBi();
        const chunks: Buffer[] = [];
        for (;;) {
          const part = await directStream.read();
          if (!part) break;
          chunks.push(part);
        }
        const raw = Buffer.concat(chunks).toString("utf-8");
        payload = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
      }

      await this.client.validateAgentInput(this.config.imageAgentId, payload, {
        label: "image-agent.inputs",
      });

      if (payload.type !== "image_generate_request") {
        console.log("[image-js] unsupported payload", payload);
        return;
      }

      const requestId = String(payload.request_id ?? "").trim();
      const prompt = String(payload.prompt ?? "").trim();

      let responsePayload: Record<string, unknown>;
      if (!requestId || !prompt) {
        responsePayload = {
          type: "image_generate_response",
          request_id: requestId || "unknown",
          image_url: null,
          revised_prompt: null,
          error: "invalid request payload",
        };
      } else {
        const revisedPrompt = await this.refinePrompt(prompt);
        try {
          const imageUrl = await this.generateImage(revisedPrompt);
          responsePayload = {
            type: "image_generate_response",
            request_id: requestId,
            image_url: imageUrl,
            revised_prompt: revisedPrompt,
            error: null,
          };
        } catch (err) {
          responsePayload = {
            type: "image_generate_response",
            request_id: requestId,
            image_url: null,
            revised_prompt: revisedPrompt,
            error: err instanceof Error ? err.message : String(err),
          };
        }
      }

      await this.client.validateAgentOutput(this.config.imageAgentId, responsePayload, {
        label: "image-agent.outputs",
      });

      if (handle.result.mode === "relay") {
        await handle.result.transport.relaySend(
          handle.result.token,
          handle.result.sessionId,
          responsePayload,
        );
      } else if (directStream) {
        await directStream.write(Buffer.from(JSON.stringify(responsePayload), "utf-8"));
        await directStream.finish();
        await new Promise((resolve) => setTimeout(resolve, 50));
      }

      console.log(`[image-js] response sent request_id=${responsePayload.request_id}`);
    } finally {
      if (handle.result.mode === "relay") {
        handle.result.transport.close();
      } else {
        handle.result.connection.close();
      }
    }
  }

  private async refinePrompt(prompt: string): Promise<string> {
    const response = await this.refiner.invoke([
      ["system",
        "You convert rough image requests into one high-quality prompt for an image model. Return only the improved prompt.",
      ],
      ["human", prompt],
    ]);
    const text = typeof response.content === "string" ? response.content.trim() : JSON.stringify(response.content);
    return text || prompt;
  }

  private async generateImage(prompt: string): Promise<string> {
    const result = await this.openai.images.generate({
      model: this.config.imageModel,
      prompt,
      size: "1024x1024",
    });

    const imageUrl = result.data?.[0]?.url;
    if (!imageUrl) {
      throw new Error("Image URL is missing in OpenAI response");
    }
    return imageUrl;
  }
}

async function main(): Promise<void> {
  const app = new ImageGenerationAgentApp();
  await app.start();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
