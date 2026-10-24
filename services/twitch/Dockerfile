FROM node:22-alpine AS build
RUN corepack enable
WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile && pnpm --filter @roastbot/twitch... build
# Readable for the unprivileged runtime user whatever the host umask was at checkout time
# (a server shell left at `umask 077` writes source files as 0600).
RUN chmod -R a+rX /app

FROM node:22-alpine
WORKDIR /app
COPY --from=build /app /app
USER node
CMD ["node", "services/twitch/dist/index.js"]
