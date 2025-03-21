#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from '@modelcontextprotocol/sdk/types.js';
import { exec } from 'child_process';
import util from 'util';

const execPromise = util.promisify(exec);

const isValidSearchArgs = (args: any): args is { query: string } =>
  typeof args === 'object' && args !== null && typeof args.query === 'string';

class NpmSearchServer {
  private server: Server;

  constructor() {
    this.server = new Server(
      {
        name: 'npm-search-server',
        version: '0.1.0',
      },
      {
        capabilities: {
          tools: {},
        },
      }
    );

    this.setupToolHandlers();

    // Error handling
    this.server.onerror = (error) => console.error('[MCP Error]', error);
    process.on('SIGINT', async () => {
      await this.server.close();
      process.exit(0);
    });
  }

  private setupToolHandlers() {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        {
          name: 'search_npm_packages', // Unique identifier
          description: 'Search for npm packages', // Human-readable description
          inputSchema: {
            // JSON Schema for parameters
            type: 'object',
            properties: {
              query: {
                type: 'string',
                description: 'Search query',
              },
            },
            required: ['query'], // Array of required property names
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

      if (!isValidSearchArgs(request.params.arguments)) {
        throw new McpError(
          ErrorCode.InvalidParams,
          'Invalid search arguments'
        );
      }

      const query = request.params.arguments.query;

      try {
        const { stdout, stderr } = await execPromise(`npm search ${query}`);
        if (stderr) {
          throw new McpError(
            ErrorCode.InternalError,
            `npm search error: ${stderr}`
          );
        }

        return {
          content: [
            {
              type: 'text',
              text: stdout,
            },
          ],
        };
      } catch (error) {
        if (error instanceof McpError) {
          throw error;
        }
        if (error instanceof Error) {
          throw new McpError(
            ErrorCode.InternalError,
            `Unexpected error: ${error.message}`
          );
        }
        throw new McpError(
          ErrorCode.InternalError,
          'Unexpected error occurred'
        );
      }
    });
  }

  async run() {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    console.error('Npm Search MCP server running on stdio');
  }
}

const server = new NpmSearchServer();
server.run().catch(console.error);
