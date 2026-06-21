# syntax=docker/dockerfile:1
FROM node:20-alpine AS builder

WORKDIR /app
COPY package*.json ./
RUN npm ci

COPY . .
RUN npm run build

# ── Production image (serve static files with vite preview) ──────────────────
FROM node:20-alpine AS runner

WORKDIR /app
COPY package*.json ./
RUN npm ci

COPY --from=builder /app/dist ./dist

EXPOSE 4173

HEALTHCHECK --interval=10s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- http://127.0.0.1:4173 || exit 1

CMD ["npm", "run", "preview"]
