FROM node:22-alpine AS build
RUN corepack enable
WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile && pnpm --filter @roastbot/worker... build
# Readable for the unprivileged runtime user whatever the host umask was at checkout time
# (a server shell left at `umask 077` writes source files as 0600).
RUN chmod -R a+rX /app

FROM node:22-alpine
WORKDIR /app
COPY --from=build /app /app
RUN mkdir -p /data/audio && chown -R node:node /data
USER node
CMD ["node", "services/worker/dist/index.js"]
