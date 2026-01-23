#!/usr/bin/env node
/**
 * npm Search MCP Server
 *
 * Provides MCP tools for searching npm packages using the `npm search` command.
 * Supports both stdio and HTTP (streamable-http) transport modes.
 *
 * HTTP mode is automatically enabled when the PORT environment variable is set.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from '@modelcontextprotocol/sdk/types.js';
import { exec } from 'child_process';
import { randomUUID } from 'node:crypto';
import util from 'util';
import express, { type Request, type Response as ExpressResponse } from 'express';
import * as z from 'zod';

const execPromise = util.promisify(exec);

const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : undefined;
const USE_HTTP = PORT !== undefined;

// Session management for HTTP transport (one transport per MCP session)
const transports = new Map<string, StreamableHTTPServerTransport>();

/**
 * Zod schema for validating search tool arguments
 */
const SearchArgsSchema = z.object({
  query: z.string().min(1, 'Search query cannot be empty'),
});

/**
 * Extracts MCP session ID from HTTP request headers
 */
function getSessionId(
  headers: Request['headers'] | Record<string, string | string[] | undefined>
): string | undefined {
  const header = headers['mcp-session-id'] || headers['Mcp-Session-Id'];
  return typeof header === 'string' ? header : undefined;
}

/**
 * Sends a JSON-RPC error response
 */
function sendErrorResponse(
  res: ExpressResponse,
  statusCode: number,
  errorCode: number,
  message: string
): void {
  res.status(statusCode).json({
    jsonrpc: '2.0',
    error: {
      code: errorCode,
      message,
    },
    id: null,
  });
}

/**
 * MCP Server for npm package search
 *
 * Provides tools for searching npm packages using the `npm search` command.
 */
class NpmSearchServer {
  private server: Server;

  constructor() {
    this.server = new Server(
      {
        name: 'npm-search-server',
        version: '0.1.1',
      },
      {
        capabilities: {
          tools: {},
        },
      }
    );

    this.setupToolHandlers();
    this.setupErrorHandling();
  }

  /**
   * Sets up error handling for the MCP server
   */
  private setupErrorHandling(): void {
    this.server.onerror = (error) => console.error('[MCP Error]', error);
    process.on('SIGINT', async () => {
      await this.server.close();
      process.exit(0);
    });
  }

  /**
   * Sets up MCP tool handlers
   */
  private setupToolHandlers(): void {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        {
          name: 'search_npm_packages',
          description: 'Search for npm packages using the npm search command',
          inputSchema: {
            type: 'object',
            properties: {
              query: {
                type: 'string',
                description: 'Search query to find npm packages',
              },
            },
            required: ['query'],
          },
        },
      ],
    }));

    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      if (request.params.name !== 'search_npm_packages') {
        throw new McpError(
          ErrorCode.MethodNotFound,
          `Unknown tool: ${request.params.name}`
        );
      }

      // Validate arguments using Zod schema
      const validationResult = SearchArgsSchema.safeParse(
        request.params.arguments
      );
      if (!validationResult.success) {
        throw new McpError(
          ErrorCode.InvalidParams,
          `Invalid search arguments: ${validationResult.error.message}`
        );
      }

      const { query } = validationResult.data;

      try {
        const { stdout, stderr } = await execPromise(`npm search ${query}`);
        
        // npm search may write warnings to stderr even on success.
        // Only treat it as an error if stdout is empty (indicating a real failure).
        if (stderr && !stdout) {
          throw new McpError(
            ErrorCode.InternalError,
            `npm search error: ${stderr}`
          );
        }

        return {
          content: [
            {
              type: 'text',
              text: stdout || 'No packages found',
            },
          ],
        };
      } catch (error) {
        // Re-throw MCP errors as-is
        if (error instanceof McpError) {
          throw error;
        }
        
        // Convert other errors to MCP errors
        const message = error instanceof Error ? error.message : 'Unexpected error occurred';
        throw new McpError(ErrorCode.InternalError, message);
      }
    });
  }

  /**
   * Runs the server with stdio transport (default mode)
   */
  async runStdio(): Promise<void> {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    console.error('Npm Search MCP server running on stdio');
  }

  /**
   * Gets the underlying MCP server instance
   */
  getServer(): Server {
    return this.server;
  }
}

/**
 * Sets up HTTP transport with Express server
 * 
 * @param server - The NpmSearchServer instance (unused but kept for API consistency)
 * @param port - The port number to listen on
 */
function setupHttpTransport(_server: NpmSearchServer, port: number): void {
  const app = express();
  app.use(express.json({ limit: '10mb' }));

  // Health check endpoint for Docker healthchecks
  app.get('/health', (_req: Request, res: ExpressResponse) => {
    res.json({
      status: 'ok',
      service: 'mcp-npm-search',
      activeSessions: transports.size,
    });
  });

  // Main MCP endpoint - handles both new session initialization and existing session requests
  app.post('/mcp', async (req: Request, res: ExpressResponse) => {
    try {
      const sessionId = getSessionId(req.headers);

      // Handle existing session
      if (sessionId) {
        const transport = transports.get(sessionId);
        if (transport) {
          await transport.handleRequest(req, res, req.body);
          return;
        }
        sendErrorResponse(res, 404, -32000, 'Session not found');
        return;
      }

      // No session ID - only allow initialize requests to create new sessions
      const isInitialize =
        typeof req.body === 'object' &&
        req.body !== null &&
        'method' in req.body &&
        req.body.method === 'initialize';

      if (!isInitialize) {
        sendErrorResponse(res, 400, -32000, 'Bad Request: No session ID provided');
        return;
      }

      // Create new session for initialize request
      const newServer = new NpmSearchServer();
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        enableJsonResponse: true,
        onsessioninitialized: (sessionId: string) => {
          console.log(`Session initialized: ${sessionId}`);
          transports.set(sessionId, transport);
        },
      });

      newServer.getServer().onclose = async () => {
        const sid = transport.sessionId;
        if (sid && transports.has(sid)) {
          console.log(`Session closed: ${sid}`);
          transports.delete(sid);
        }
      };

      await newServer.getServer().connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error('Error handling MCP request:', errorMessage);
      if (!res.headersSent) {
        sendErrorResponse(res, 500, -32603, 'Internal server error');
      }
    }
  });

  app.listen(port, '0.0.0.0', () => {
    console.log(`Npm Search MCP server running on port ${port}`);
  });
}

/**
 * Main entry point - initializes server and selects transport mode based on PORT env var
 */
async function main(): Promise<void> {
  if (USE_HTTP && PORT !== undefined) {
    const server = new NpmSearchServer();
    setupHttpTransport(server, PORT);
  } else if (USE_HTTP) {
    throw new Error('PORT environment variable must be set for HTTP transport mode');
  } else {
    const server = new NpmSearchServer();
    await server.runStdio();
  }
}

main().catch(console.error);
