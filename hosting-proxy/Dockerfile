FROM nginx:1.28-alpine

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
# beneath /apps/<slug>. The explicit entrypoint stays non-root.
COPY --chown=101:101 nginx.conf.template /etc/kust-proxy/nginx.conf.template
COPY --chown=101:101 docker-entrypoint.sh /usr/local/bin/kust-proxy-entrypoint
RUN chmod 0755 /usr/local/bin/kust-proxy-entrypoint

USER 101:101
ENTRYPOINT ["/usr/local/bin/kust-proxy-entrypoint"]

EXPOSE 8080
