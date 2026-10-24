FROM node:22-alpine AS build
RUN corepack enable
WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile && pnpm --filter @roastbot/twitch... build

FROM node:22-alpine
WORKDIR /app
COPY --from=build /app /app
USER node
CMD ["node", "services/twitch/dist/index.js"]
