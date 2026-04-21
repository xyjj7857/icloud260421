# Use a lightweight Node.js 20 image
FROM node:20-slim AS builder

# Set working directory
WORKDIR /app

# Install build dependencies for better-sqlite3 if needed
RUN apt-get update && apt-get install -y \
    python3 \
    make \
    g++ \
    && rm -rf /var/lib/apt/lists/*

# Copy package files
COPY package*.json ./

# Install all dependencies (including dev for build)
RUN npm install

# Copy project files
COPY . .

# Build the frontend assets
RUN npm run build

# --- Intermediate Stage: Production Dependencies ---
FROM node:20-slim AS deps
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev

# --- Final Production Stage ---
FROM node:20-slim
WORKDIR /app

# Install runtime dependencies for better-sqlite3
RUN apt-get update && apt-get install -y \
    openssl \
    && rm -rf /var/lib/apt/lists/*

# Copy built frontend and production node_modules
COPY --from=builder /app/dist ./dist
COPY --from=deps /app/node_modules ./node_modules
COPY --from=builder /app/server.ts ./
COPY --from=builder /app/database.ts ./
COPY --from=builder /app/package.json ./

# Create data directory for SQLite persistence
RUN mkdir -p /app/data

# Ensure tsx is available in node_modules or use a pre-compiled server
# Since the app uses tsx in production script, we need to ensure it's either in deps or we use ts-node
# Actually, tsx is in devDeps. Let's move it to dependencies or just use bare node if we compile.
# To keep it simple and consistent with the user's start script:
COPY --from=builder /app/node_modules/tsx ./node_modules/tsx
COPY --from=builder /app/node_modules/.bin/tsx ./node_modules/.bin/tsx

# Set environment to production
ENV NODE_ENV=production
ENV PORT=3333

# Expose the application port
EXPOSE 3333

# Start the application
CMD ["npm", "run", "start"]
