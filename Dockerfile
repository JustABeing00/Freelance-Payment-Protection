# Production image for FreelancePaymentProtection.
# Solo-founder flow: `docker build -t fpp .` then run with --env-file .env
# (see docs/deployment.md). Migrations run separately via `npm run prisma:deploy`.

FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY prisma ./prisma
RUN npx prisma generate
COPY tsconfig.json ./
COPY src ./src
RUN npm run build
RUN npm prune --omit=dev

FROM node:24-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/package.json /app/package-lock.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/prisma ./prisma
COPY --from=build /app/dist ./dist
EXPOSE 3000
# Fail-closed boot: missing DATABASE_URL / SESSION_SECRET / APP_BASE_URL
# throws before listen (src/config/env.ts). Health: GET /health.
CMD ["node", "dist/server.js"]
