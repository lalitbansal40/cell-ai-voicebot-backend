# SIPp from Alpine packages (Debian has no sipp package; public SIPp images are outdated / amd64-only).
FROM alpine:3.24
RUN apk add --no-cache sipp
WORKDIR /sipp
ENTRYPOINT ["sipp"]
