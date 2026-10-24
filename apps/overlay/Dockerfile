FROM node:22-alpine AS build
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/overlay/package.json apps/overlay/
RUN pnpm install --filter @roastbot/overlay... --frozen-lockfile
COPY apps/overlay apps/overlay
ARG VITE_API_URL
ENV VITE_API_URL=$VITE_API_URL
RUN pnpm --filter @roastbot/overlay build
# Readable for the unprivileged runtime user whatever the host umask was at checkout time
# (a server shell left at `umask 077` writes source files as 0600).
RUN chmod -R a+rX apps/overlay/dist

FROM nginx:1.27-alpine
COPY apps/overlay/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/apps/overlay/dist /usr/share/nginx/html
EXPOSE 80
