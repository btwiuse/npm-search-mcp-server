FROM node:24-alpine

WORKDIR /app

# Copy package files
COPY package*.json ./
COPY tsconfig.json tsconfig.base.json ./

# Install all dependencies (including dev dependencies for build)
# Use --ignore-scripts to skip the prepare hook (which runs build) until source files are copied
RUN npm install --ignore-scripts

# Copy source files
COPY . .

# Build TypeScript
RUN npm run build

# Remove dev dependencies after build to reduce image size
RUN npm prune --production

# Set environment variables
ENV NODE_ENV=production
ENV PORT=3009

# Expose port
EXPOSE 3009

# Run the server (automatically uses HTTP transport if PORT is set, otherwise stdio)
CMD ["node", "dist/index.js"]