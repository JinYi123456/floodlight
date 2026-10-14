/**
 * The live match client — the production crew's fact-checking path.
 *
 * Inside the running pipeline the crew does not read the engine directly:
 * it speaks MCP to it. An in-memory transport links a real MCP server (the
 * live tool surface) to a real MCP client, and the client is wrapped back
 * into the MatchFacts interface the agents already consume. Browser-safe by
 * construction — the same handshake an external agent host performs over
 * stdio happens here in-process, per frame if it needs to.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { MatchFacts } from '@floodlight/dataservice';
import { factsOverClient, registerLiveTools, type LiveEngineLike } from './tools';

export const LIVE_SERVER_NAME = 'floodlight-live';
export const CREW_CLIENT_NAME = 'floodlight-crew';

/**
 * Attach the crew to a live engine over a linked in-memory MCP transport and
 * hand back a MatchFacts implementation backed by tool calls.
 */
export async function createLiveFactsClient(engine: LiveEngineLike): Promise<MatchFacts> {
  const server = new McpServer({ name: LIVE_SERVER_NAME, version: '1.0.0' });
  registerLiveTools(server, engine);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: CREW_CLIENT_NAME, version: '1.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return factsOverClient(client);
}
