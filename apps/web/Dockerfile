FROM node:22-alpine AS build
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/web/package.json apps/web/
RUN pnpm install --filter @roastbot/web... --frozen-lockfile
COPY apps/web apps/web
ARG VITE_API_URL=/api
ARG VITE_OVERLAY_URL=/overlay
ARG VITE_SITE_URL=https://roast.recursia.online
ENV VITE_API_URL=$VITE_API_URL
ENV VITE_OVERLAY_URL=$VITE_OVERLAY_URL
ENV VITE_SITE_URL=$VITE_SITE_URL
RUN pnpm --filter @roastbot/web build
# Readable for the unprivileged runtime user whatever the host umask was at checkout time
# (a server shell left at `umask 077` writes source files as 0600).
RUN chmod -R a+rX apps/web/dist

FROM nginx:1.27-alpine
COPY apps/web/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/apps/web/dist /usr/share/nginx/html
EXPOSE 80
