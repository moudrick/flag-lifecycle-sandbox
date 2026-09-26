# Page keeper: a resident headless browser holding one public page open.
# Alpine's chromium package is built for both amd64 and arm64, so the same file serves an Intel
# Linux host and an Apple Silicon Mac without a registry.
FROM alpine:3.20

RUN apk add --no-cache chromium ca-certificates font-noto

COPY keep-open.sh /usr/local/bin/keep-open.sh
RUN chmod +x /usr/local/bin/keep-open.sh

# The root filesystem is read-only in Compose, so everything the browser writes goes to the tmpfs.
ENV HOME=/tmp
ENV XDG_CONFIG_HOME=/tmp
ENV XDG_CACHE_HOME=/tmp

# No SDK key ever reaches this container, so it runs unprivileged. Compose supplies the init process.
USER nobody

ENTRYPOINT ["/usr/local/bin/keep-open.sh"]
