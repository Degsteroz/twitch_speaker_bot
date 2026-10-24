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

FROM nginx:1.27-alpine
COPY apps/overlay/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/apps/overlay/dist /usr/share/nginx/html
EXPOSE 80
