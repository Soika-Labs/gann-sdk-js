import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { randomUUID } from "node:crypto";
import { ChatOpenAI } from "@langchain/openai";

import { buildClient, loadConfig } from "./common.js";

class GeneralChatAgentApp {
  private readonly config = loadConfig();
  private readonly client = buildClient(this.config);
  private readonly chatLlm = new ChatOpenAI({ model: this.config.chatModel, temperature: 0.6 });
  private readonly intentLlm = new ChatOpenAI({ model: this.config.chatModel, temperature: 0.0 });

  async start(): Promise<void> {
    console.log("[general-js] connecting to GANN...");
    await this.client.connectAgent(this.config.generalAgentId, {
      onError: (err: Error) => console.error("[general-js] error:", err.message),
    });
    await this.client.fetchAgentSchema(this.config.imageAgentId);
    console.log(`[general-js] online as ${this.config.generalAgentId}`);
  }

  stop(): void {
    this.client.disconnect();
  }

  async runCli(): Promise<void> {
    await this.start();
    const rl = createInterface({ input, output });
    console.log("\nGeneral chat agent ready. Type messages (or 'exit').\n");

    try {
      for (;;) {
        let rawMessage: string;
        try {
          rawMessage = await rl.question("You: ");
        } catch (err) {
          if ((err as { code?: string } | undefined)?.code === "ERR_USE_AFTER_CLOSE") {
            break;
          }
          throw err;
        }
        const message = rawMessage.trim();
        if (!message) continue;
        if (message.toLowerCase() === "exit" || message.toLowerCase() === "quit") break;
        const answer = await this.handleUserMessage(message);
        console.log(`Agent: ${answer}\n`);
      }
    } finally {
      rl.close();
      this.stop();
    }
  }

  private async handleUserMessage(message: string): Promise<string> {
    const imagePrompt = await this.extractImagePrompt(message);
    if (!imagePrompt) {
      return this.generalChat(message);
    }

    const requestPayload: Record<string, unknown> = {
      type: "image_generate_request",
      request_id: randomUUID(),
      prompt: imagePrompt,
    };

    await this.client.validateAgentInput(this.config.imageAgentId, requestPayload, {
      label: "image-agent.inputs",
    });

    const handle = await this.client.dialQuicDirectFirst(this.config.imageAgentId, {
      directTimeoutMs: 3_000,
      directBindAddr: "127.0.0.1:0",
    });
    console.log(`[general-js] connected to image agent mode=${handle.result.mode} session=${handle.result.sessionId}`);

    try {
      let responsePayload: Record<string, unknown>;

      if (handle.result.mode === "relay") {
        let peerReady = Boolean(handle.result.peerReady);
        const deadline = Date.now() + 20_000;
        while (!peerReady && Date.now() < deadline) {
          peerReady = await handle.result.transport.relayBind(
            handle.result.token,
            handle.result.sessionId,
          );
          if (!peerReady) {
            await new Promise((resolve) => setTimeout(resolve, 100));
          }
        }
        if (!peerReady) {
          throw new Error("relay peer was not ready in time");
        }

        await handle.result.transport.relaySend(
          handle.result.token,
          handle.result.sessionId,
          requestPayload,
        );
        const frame = await handle.result.transport.recvRelayData();
        responsePayload = frame.payload as Record<string, unknown>;
      } else {
        const stream = await handle.result.connection.openBi();
        await stream.write(Buffer.from(JSON.stringify(requestPayload), "utf-8"));
        await stream.finish();

        const chunks: Buffer[] = [];
        for (;;) {
          const part = await stream.read();
          if (!part) break;
          chunks.push(part);
        }
        const raw = Buffer.concat(chunks).toString("utf-8");
        responsePayload = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
      }

      await this.client.validateAgentOutput(this.config.imageAgentId, responsePayload, {
        label: "image-agent.outputs",
      });

      const error = responsePayload.error;
      if (typeof error === "string" && error.length > 0) {
        return `Image agent error: ${error}`;
      }

      const imageUrl = responsePayload.image_url;
      const revisedPrompt = responsePayload.revised_prompt;
      return [
        "Done. I delegated image generation to the image agent over GANN QUIC.",
        `Revised prompt: ${typeof revisedPrompt === "string" ? revisedPrompt : imagePrompt}`,
        `Image URL: ${typeof imageUrl === "string" ? imageUrl : "(missing)"}`,
      ].join("\n");
    } finally {
      try {
        handle.channel.disconnectSession(handle.result.sessionId, this.config.imageAgentId, "request_completed");
      } catch {
        // best-effort teardown
      }
      if (handle.result.mode === "relay") {
        handle.result.transport.close();
      } else {
        handle.result.connection.close();
      }
      handle.channel.close(1000, "done");
    }
  }

  private async generalChat(message: string): Promise<string> {
    const response = await this.chatLlm.invoke([
      ["system", "You are a helpful general chat assistant."],
      ["human", message],
    ]);
    if (typeof response.content === "string") {
      return response.content;
    }
    return JSON.stringify(response.content);
  }

  private async extractImagePrompt(message: string): Promise<string | null> {
    const response = await this.intentLlm.invoke([
      ["system",
        "Determine if user asks to create/generate/draw an image. If yes, return only the image prompt text. If no, return exactly NONE.",
      ],
      ["human", message],
    ]);
    const text = typeof response.content === "string" ? response.content.trim() : JSON.stringify(response.content);
    if (text.toUpperCase() === "NONE") {
      return null;
    }
    return text;
  }
}

async function main(): Promise<void> {
  const app = new GeneralChatAgentApp();
  await app.runCli();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
