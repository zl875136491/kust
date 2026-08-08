FROM nginxinc/nginx-unprivileged:1.27-alpine

ARG VCS_REF=unknown
ARG IMAGE_VERSION=dev
ARG SOURCE_URL=https://github.com/zl875136491/kust

LABEL org.opencontainers.image.authors="NC_SIT_ZHANGLE" \
      org.opencontainers.image.title="Kust Hosted Application Proxy" \
      org.opencontainers.image.source="${SOURCE_URL}" \
      org.opencontainers.image.version="${IMAGE_VERSION}" \
      org.opencontainers.image.revision="${VCS_REF}" \
      org.opencontainers.image.component="hosting-proxy"

# The upstream application remains isolated on loopback. This sidecar owns the
# public path prefix and makes framework applications that assume '/' usable
# beneath /apps/<slug>.
COPY nginx.conf.template /etc/nginx/templates/default.conf.template

EXPOSE 8080
