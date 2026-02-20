#!/usr/bin/env node
/**
 * npm Search MCP Server
 *
 * Provides MCP tools for searching npm packages using the `npm search` command.
 * Supports both stdio and HTTP (streamable-http) transport modes.
 *
 * Features:
 * - Search npm packages via command-line interface
 * - Supports both stdio and HTTP transport modes
 * - Structured logging with Pino
 * - Graceful shutdown handling
 * - Health check endpoint
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
import { logger } from './src/utils/logger.js';

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
 * Extracts the actual tool name from a potentially prefixed tool name.
 * 
 * LibreChat may send tool names in the format `toolName_mcp_serverName` or `toolName-mcp-serverName`
 * to distinguish tools from different MCP servers. This function extracts just the tool name.
 * 
 * @param toolName - The tool name as received (may include server suffix)
 * @returns The extracted tool name without any server suffix
 * 
 * @example
 * extractToolName('search_npm_packages_mcp_npm-search') // 'search_npm_packages'
 * extractToolName('search_npm_packages-mcp-server') // 'search_npm_packages'
 * extractToolName('search_npm_packages') // 'search_npm_packages'
 */
function extractToolName(toolName: string): string {
  // Match any occurrence of _mcp or -mcp (case-insensitive) and extract everything before it
  const mcpDelimiterPattern = /[_-]mcp/i;
  const match = toolName.match(mcpDelimiterPattern);
  return match && match.index !== undefined
    ? toolName.substring(0, match.index)
    : toolName;
}

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
 * Sends a JSON-RPC error response.
 * Prevents sending response if headers have already been sent.
 *
 * @param res - Express response object
 * @param statusCode - HTTP status code
 * @param errorCode - JSON-RPC error code
 * @param message - Error message
 * @param id - Optional request ID for correlation
 */
function sendErrorResponse(
  res: ExpressResponse,
  statusCode: number,
  errorCode: number,
  message: string,
  id: unknown = null
): void {
  if (res.headersSent) {
    return;
  }
  res.status(statusCode).json({
    jsonrpc: '2.0',
    error: {
      code: errorCode,
      message,
    },
    id,
  });
}

/**
 * MCP Server for npm package search.
 *
 * Provides tools for searching npm packages using the `npm search` command.
 * Supports both stdio and HTTP (streamable-http) transport modes.
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
   * Sets up error handling for the MCP server.
   * Configures error handlers for the MCP server and process signals.
   */
  private setupErrorHandling(): void {
    this.server.onerror = (error) => logger.error({ error }, 'MCP Error');
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
      const requestedToolName = request.params.name;
      const toolName = extractToolName(requestedToolName);

      if (toolName !== 'search_npm_packages') {
        throw new McpError(
          ErrorCode.MethodNotFound,
          `Unknown tool: ${requestedToolName} (extracted: ${toolName})`
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
        // Re-throw MCP errors as-is to preserve error context
        if (error instanceof McpError) {
          throw error;
        }
        
        // Convert other errors to MCP errors with appropriate error code
        const message = error instanceof Error ? error.message : 'Unexpected error occurred';
        throw new McpError(ErrorCode.InternalError, message);
      }
    });
  }

  /**
   * Runs the server with stdio transport (default mode).
   * Connects the server to stdio transport and logs startup message.
   */
  async runStdio(): Promise<void> {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    logger.info('Npm Search MCP server running on stdio');
  }

  /**
   * Gets the underlying MCP server instance.
   *
   * @returns The MCP server instance
   */
  getServer(): Server {
    return this.server;
  }
}

/**
 * Sets up HTTP transport with Express server
 *
 * Configures all standard MCP endpoints:
 * - GET /health - Health check endpoint
 * - GET /mcp - SSE stream endpoint (returns 404 for stateless servers)
 * - DELETE /mcp - Session termination endpoint
 * - POST /mcp - Main MCP endpoint for requests
 *
 * @param server - The NpmSearchServer instance (unused but kept for API consistency)
 * @param port - The port number to listen on
 */
function setupHttpTransport(_server: NpmSearchServer, port: number): void {
  const app = express();
  app.use(express.json({ limit: '10mb' }));
  app.disable('x-powered-by');

  // Health check endpoint for Docker healthchecks
  app.get('/health', (_req: Request, res: ExpressResponse) => {
    res.json({
      status: 'ok',
      service: 'mcp-npm-search',
      version: '0.1.1',
      activeSessions: transports.size,
    });
  });

  // SSE stream endpoint (GET /mcp)
  // According to MCP specification, StreamableHTTPServerTransport.handleRequest
  // can handle both POST and GET requests, automatically processing SSE streams
  // when Accept: text/event-stream header is present.
  app.get('/mcp', async (req: Request, res: ExpressResponse) => {
    const sessionId = getSessionId(req.headers);

    if (!sessionId) {
      sendErrorResponse(res, 400, -32000, 'Bad Request: No session ID provided');
      return;
    }

    const transport = transports.get(sessionId);
    if (!transport) {
      sendErrorResponse(res, 404, -32000, 'Session not found');
      return;
    }

    try {
      // transport.handleRequest automatically handles GET with Accept: text/event-stream
      // It will set appropriate SSE headers and stream responses
      await transport.handleRequest(req, res, null);
    } catch (error) {
      logger.error(
        { error: error instanceof Error ? error.message : String(error), sessionId },
        'Error handling SSE stream request',
      );
      sendErrorResponse(res, 500, -32603, 'Internal server error');
    }
  });

  // Session termination endpoint (DELETE /mcp)
  app.delete('/mcp', async (req: Request, res: ExpressResponse) => {
    const sessionId = getSessionId(req.headers);

    if (!sessionId) {
      sendErrorResponse(res, 400, -32000, 'Bad Request: No session ID provided');
      return;
    }

    const transport = transports.get(sessionId);
    if (!transport) {
      sendErrorResponse(res, 404, -32000, 'Session not found');
      return;
    }

    try {
      await transport.handleRequest(req, res, req.body);
      transports.delete(sessionId);
      logger.info({ sessionId, totalSessions: transports.size }, 'Session deleted');
    } catch (error) {
      logger.error({ error: error instanceof Error ? error.message : String(error), sessionId }, 'Error handling session termination');
      sendErrorResponse(res, 500, -32603, 'Error handling session termination');
    }
  });

  // Main MCP endpoint (POST /mcp)
  app.post('/mcp', async (req: Request, res: ExpressResponse) => {
    try {
      const sessionId = getSessionId(req.headers);
      const requestId = typeof req.body === 'object' && req.body !== null && 'id' in req.body ? req.body.id : null;

      // Handle existing session
      if (sessionId) {
        const transport = transports.get(sessionId);
        if (transport) {
          await transport.handleRequest(req, res, req.body);
          return;
        }
        sendErrorResponse(res, 404, -32000, 'Session not found', requestId);
        return;
      }

      // No session ID - only allow initialize requests to create new sessions
      const isInitialize =
        typeof req.body === 'object' &&
        req.body !== null &&
        'method' in req.body &&
        req.body.method === 'initialize';

      if (!isInitialize) {
        sendErrorResponse(res, 400, -32000, 'Bad Request: No session ID provided', requestId);
        return;
      }

      // Create new session for initialize request
      const newServer = new NpmSearchServer();
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        enableJsonResponse: true,
        onsessioninitialized: (sessionId: string) => {
          logger.info({ sessionId, totalSessions: transports.size + 1 }, 'Session initialized');
          transports.set(sessionId, transport);
        },
      });

      newServer.getServer().onclose = async () => {
        const sid = transport.sessionId;
        if (sid && transports.has(sid)) {
          logger.info({ sessionId: sid, totalSessions: transports.size - 1 }, 'Session closed');
          transports.delete(sid);
        }
      };

      await newServer.getServer().connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error({ error: errorMessage }, 'Error handling MCP request');
      const requestId = typeof req.body === 'object' && req.body !== null && 'id' in req.body ? req.body.id : null;
      sendErrorResponse(res, 500, -32603, 'Internal server error', requestId);
    }
  });

  const server = app.listen(port, '0.0.0.0', () => {
    logger.info({ port }, 'Npm Search MCP server started');
  });

  // Graceful shutdown handler
  const shutdown = async () => {
    logger.info('Shutting down...');
    for (const [sessionId, transport] of transports.entries()) {
      try {
        await transport.close();
      } catch (error) {
        logger.error({ error: error instanceof Error ? error.message : String(error), sessionId }, 'Error closing transport');
      }
    }
    transports.clear();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    process.exit(0);
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
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

main().catch((error) => {
  logger.error({ error }, 'Fatal error');
  process.exit(1);
});
