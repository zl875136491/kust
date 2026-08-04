FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run lint && npm run build

FROM nginx:1.28-alpine AS runtime

ARG VCS_REF=unknown
ARG IMAGE_VERSION=dev
ARG SOURCE_URL=https://github.com/zl875136491/kust

LABEL org.opencontainers.image.authors="NC_SIT_ZHANGLE" \
      org.opencontainers.image.title="Kust Frontend" \
      org.opencontainers.image.source="${SOURCE_URL}" \
      org.opencontainers.image.version="${IMAGE_VERSION}" \
      org.opencontainers.image.revision="${VCS_REF}" \
      org.opencontainers.image.component="frontend"

ENV API_UPSTREAM=api:8080 \
    APP_BASE_PATH=/

COPY nginx.conf /etc/nginx/templates/default.conf.template
COPY docker-entrypoint.d/25-kust-base-path.sh /docker-entrypoint.d/25-kust-base-path.sh
COPY --from=build /app/dist /usr/share/nginx/html
RUN chmod 0755 /docker-entrypoint.d/25-kust-base-path.sh

EXPOSE 80

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1/healthz || exit 1
