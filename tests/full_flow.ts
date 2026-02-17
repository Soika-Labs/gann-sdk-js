/// <reference types="node" />
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import {
  AgentSearchResponse,
  CapabilityDescriptor,
  GannAgentClient,
} from "../src/index.js";

const CAPABILITIES: CapabilityDescriptor[] = [
  { name: "text.generate", description: "Long-form copy generation" },
  { name: "text.summarize", description: "Summaries" },
];

const AGENT_INPUTS = {
  "text.generate": { schema: "markdown|string", required: ["prompt"] },
  "text.summarize": { schema: "text", required: ["text"] },
};

const AGENT_OUTPUTS = {
  "text.generate": { primary: "markdown" },
  "text.summarize": { primary: "summary" },
};

type AgentHandle = {
  label: string;
  cost: number;
  status: string;
  agentId: string;
  appId: string;
  client: GannAgentClient;
};

type GannOwnerClient = GannAgentClient;

async function main(): Promise<void> {
  const baseUrl = process.env.GANN_BASE_URL ?? "http://127.0.0.1:8080";
  const ownerApiKey = process.env.GANN_API_KEY;
  if (!ownerApiKey) {
    throw new Error("GANN_API_KEY must be set to run the JS full-flow test");
  }

  const ownerClient = new GannAgentClient({ baseUrl, apiKey: ownerApiKey });
  const agents: AgentHandle[] = [];

  try {
    agents.push(await registerAgent(baseUrl, ownerApiKey, ownerClient, "Atlas.Writer", 4, "online"));
    agents.push(await registerAgent(baseUrl, ownerApiKey, ownerClient, "Beacon.Writer", 7, "degraded"));

    await sendHeartbeats(agents);
    await verifySearch(ownerClient, agents);
    await verifyFailures(baseUrl, ownerApiKey, agents);

    console.log("✅ JS SDK full-flow scenario completed successfully");
  } finally {
    await cleanupAgents(ownerClient, agents);
  }
}

async function registerAgent(
  baseUrl: string,
  apiKey: string,
  ownerClient: GannOwnerClient,
  label: string,
  cost: number,
  status: string
): Promise<AgentHandle> {
  const agentName = `${label}.${randomUUID().slice(0, 8)}`;
  const appId = `js-sdk::${label}::${randomUUID()}`;
  const response = await fetch(`${baseUrl}/.gann/register`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "GANN-API-KEY": apiKey,
    },
    body: JSON.stringify({
      agent_name: agentName,
      version: "1",
      agent_type: "agent_chat",
      app_id: appId,
      capabilities: CAPABILITIES,
      inputs: AGENT_INPUTS,
      outputs: AGENT_OUTPUTS,
      description: "JS SDK flow test agent",
      cost,
    }),
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Registration failed (${response.status}): ${text}`);
  }
  const registration = (await response.json()) as { agent_id?: string };
  const agentId = String(registration["agent_id"] ?? "");
  if (!agentId) {
    throw new Error("Agent registration did not return agent_id");
  }
  const client = new GannAgentClient({
    baseUrl,
    apiKey,
    agentId,
  });
  return { label: agentName, cost, status, agentId, appId, client };
}

async function sendHeartbeats(agents: AgentHandle[]): Promise<void> {
  await Promise.all(
    agents.map((agent) => agent.client.heartbeat({ load: agent.cost, status: agent.status }))
  );
}

async function verifySearch(ownerClient: GannOwnerClient, agents: AgentHandle[]): Promise<void> {
  const response: AgentSearchResponse = await ownerClient.searchAgents({ q: "writer" });
  const observed = new Set<string>(response.agents.map((entry) => entry.agent_id));
  for (const agent of agents) {
    assert(observed.has(agent.agentId), `agent ${agent.agentId} missing from search response`);
  }
  for (const agent of response.agents) {
    assert(typeof agent.search_score === "number" && agent.search_score > 0, "search_score missing");
  }
}

async function verifyFailures(
  baseUrl: string,
  apiKey: string,
  agents: AgentHandle[]
): Promise<void> {
  await expectGannError(
    () =>
      registerAgentDirect(baseUrl, apiKey, {
        agent_name: agents[0].label,
        version: "1",
        agent_type: "agent_chat",
        app_id: `dup::${randomUUID()}`,
        capabilities: CAPABILITIES,
        inputs: AGENT_INPUTS,
        outputs: AGENT_OUTPUTS,
        description: "duplicate test",
      }),
    400
  );

  await expectGannError(
    () =>
      registerAgentDirect(baseUrl, apiKey, {
        agent_name: `${agents[0].label}-clone`,
        version: "1",
        agent_type: "agent_chat",
        app_id: agents[0].appId,
        capabilities: CAPABILITIES,
        inputs: AGENT_INPUTS,
        outputs: AGENT_OUTPUTS,
        description: "duplicate app",
      }),
    400
  );

}

async function registerAgentDirect(
  baseUrl: string,
  apiKey: string,
  payload: Record<string, unknown>
): Promise<void> {
  const response = await fetch(`${baseUrl}/.gann/register`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "GANN-API-KEY": apiKey,
    },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`GANN request failed (${response.status}): ${text}`);
  }
}

async function expectGannError(fn: () => Promise<unknown>, statusCode: number): Promise<void> {
  try {
    await fn();
  } catch (error) {
    if (error instanceof Error && error.message.includes(`(${statusCode})`)) {
      return;
    }
    throw error;
  }
  throw new Error(`expected HTTP ${statusCode} error`);
}

async function cleanupAgents(ownerClient: GannOwnerClient, agents: AgentHandle[]): Promise<void> {
  for (const agent of agents) {
    try {
      await ownerClient.deleteAgent(agent.agentId);
    } catch {
      // best-effort cleanup
    }
  }
}

main().catch((err) => {
  console.error("❌ JS SDK full-flow scenario failed", err);
  process.exit(1);
});
