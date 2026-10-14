/**
 * The studio MCP server over stdio — how an external agent host attaches.
 *
 * Point any MCP-speaking client (an agent framework, an IDE assistant, a
 * scripting host) at `floodlight-mcp` and it gets the whole studio as
 * typed tools: run the five-stage pipeline, walk the ledger, read the
 * stories, check players, pull the cue sheet, run the vision pass.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { MatchService } from '@floodlight/dataservice';
import { registerStudioTools } from './tools';

async function main(): Promise<void> {
  const server = new McpServer({ name: 'floodlight-studio', version: '1.0.0' });
  registerStudioTools(server, new MatchService());
  await server.connect(new StdioServerTransport());
}

main().catch((error) => {
  console.error('floodlight-mcp failed to start:', error);
  process.exit(1);
});
