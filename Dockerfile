# Multi-stage build for Perihelion relayer and solver containers.
# Usage:
#   docker build --build-arg PACKAGE=relayer -t perihelion-relayer .
#   docker build --build-arg PACKAGE=solver -t perihelion-solver .

FROM node:20-alpine@sha256:d0f0f9e87e9451c2ae12a69b88c65b8eba13c7fa876beb0c4f1c45301aebcc5f AS build

WORKDIR /app

# Copy root and workspace package files for dependency resolution
COPY package*.json ./
COPY sdk/package.json sdk/
COPY relayer/package.json relayer/
COPY solver/package.json solver/
COPY mempool/package.json mempool/

# Install dependencies with workspace symlink resolution
RUN npm ci

# Copy entire repository and build
COPY . .
RUN npm run build

# Runtime stage — minimal image with only production artifacts
FROM node:20-alpine@sha256:d0f0f9e87e9451c2ae12a69b88c65b8eba13c7fa876beb0c4f1c45301aebcc5f

ARG PACKAGE=relayer
WORKDIR /app

# Copy built artifacts and node_modules from build stage
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/${PACKAGE}/dist ./${PACKAGE}/dist
COPY --from=build /app/sdk/dist ./sdk/dist
COPY --from=build /app/sdk/package.json ./sdk/
COPY --from=build /app/${PACKAGE}/package.json ./${PACKAGE}/

# Create non-root user for security
RUN addgroup -g 1001 -S nodejs && adduser -S node -u 1001

USER node

# Start the relayer or solver
CMD ["node", "${PACKAGE}/dist/index.js"]
