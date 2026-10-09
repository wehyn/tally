# syntax=docker/dockerfile:1
FROM node:24-bookworm-slim AS dependencies
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci

FROM node:24-bookworm-slim AS builder
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=dependencies /app/node_modules ./node_modules
COPY . .
RUN npm run build

FROM node:24-bookworm-slim AS runner
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000 HOSTNAME=0.0.0.0
RUN groupadd --system --gid 1001 tally && useradd --system --uid 1001 --gid tally tally && mkdir -p /data && chown tally:tally /data
COPY --from=builder --chown=tally:tally /app/.next/standalone ./
COPY --from=builder --chown=tally:tally /app/.next/static ./.next/static
COPY --from=builder --chown=tally:tally /app/scripts ./scripts
USER tally
EXPOSE 3000
CMD ["node", "server.js"]
