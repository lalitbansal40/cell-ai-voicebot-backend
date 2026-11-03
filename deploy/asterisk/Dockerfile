# Asterisk 22 LTS for phone calls (ADR 0022 / 0050). Base pinned by digest; our config is rendered
# from env at start (render.sh), so no secret is baked into the image.
FROM andrius/asterisk:22@sha256:7ef51d47e9e670309b55cc287bbee64df75832b690e019cc7125c491c34f67b2

USER root
RUN rm -f /etc/asterisk/*.conf /etc/asterisk/*.ael /etc/asterisk/*.lua /etc/asterisk/*.adsi \
  && mkdir -p /etc/asterisk-templates \
  && chown asterisk:asterisk /etc/asterisk
COPY conf/ /etc/asterisk-templates/
COPY render.sh /usr/local/bin/cav-render
COPY entrypoint.sh /usr/local/bin/cav-entrypoint
RUN chmod 0755 /usr/local/bin/cav-render /usr/local/bin/cav-entrypoint \
  && chmod -R a+rX /etc/asterisk-templates

USER asterisk
EXPOSE 5060/udp 5060/tcp
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=3 \
  CMD asterisk -rx 'core show uptime' >/dev/null || exit 1
ENTRYPOINT ["/usr/local/bin/cav-entrypoint"]
