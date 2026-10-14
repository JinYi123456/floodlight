/**
 * The studio, reachable over the network — MCP on Streamable HTTP.
 *
 * The same nine studio tools the stdio server exposes, served statelessly
 * on POST /mcp so any remote MCP host can attach over plain HTTPS. A
 * fresh server + transport per request keeps the endpoint scale-to-zero
 * friendly; the MatchService behind it caches prepared matches, so repeat
 * calls are cheap.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { MatchService } from '@floodlight/dataservice';
import { registerStudioTools } from '@floodlight/mcp';

const service = new MatchService();

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk: Buffer) => {
      data += chunk.toString('utf8');
      if (data.length > 1_000_000) {
        reject(new Error('request body too large'));
        req.destroy();
      }
    });
    req.on('end', () => {
      if (!data) {
        resolve(undefined);
        return;
      }
      try {
        resolve(JSON.parse(data) as unknown);
      } catch {
        reject(new Error('request body is not valid JSON'));
      }
    });
    req.on('error', reject);
  });
}

/** Serve one MCP request (POST only — stateless Streamable HTTP). */
export async function handleMcp(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== 'POST') {
    res.writeHead(405, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(
      JSON.stringify({
        jsonrpc: '2.0',
        error: { code: -32000, message: 'Method not allowed — stateless server, POST only.' },
        id: null,
      }),
    );
    return;
  }

  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  const server = new McpServer({ name: 'floodlight-studio', version: '1.0.0' });
  registerStudioTools(server, service);
  res.on('close', () => {
    void transport.close();
    void server.close();
  });

  try {
    await server.connect(transport);
    const body = await readBody(req);
    await transport.handleRequest(req, res, body);
  } catch (error) {
    if (!res.headersSent) {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(
        JSON.stringify({
          jsonrpc: '2.0',
          error: { code: -32700, message: error instanceof Error ? error.message : String(error) },
          id: null,
        }),
      );
    }
  }
}
