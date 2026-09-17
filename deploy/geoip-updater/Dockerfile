ARG ALPINE_IMAGE=alpine:3.24

FROM ${ALPINE_IMAGE}
RUN apk add --no-cache ca-certificates gzip wget
COPY deploy/geoip-updater/update.sh /update.sh
RUN chmod 755 /update.sh
VOLUME /var/lib/qtiauth/geoip
CMD ["/update.sh"]
