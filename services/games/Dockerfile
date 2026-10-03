ARG NODE_IMAGE=node:26.10.0-alpine3.24

FROM ${NODE_IMAGE} AS deps
ARG PACKAGE=@qtiauth/games
ARG PACKAGE_DIR=services/games
RUN npm install --global pnpm@12.4.2
WORKDIR /repo
COPY . .
RUN pnpm install --frozen-lockfile --prod --ignore-scripts --filter-prod "${PACKAGE}..." \
    && mkdir /out \
    && cp -a package.json node_modules /out/ \
    && for dir in $(pnpm --filter-prod "${PACKAGE}..." exec pwd); do \
    rel="${dir#/repo/}"; mkdir -p "/out/$(dirname "$rel")"; cp -a "$dir" "/out/$rel"; \
    done \
    && find /out -name '*.test.ts' -delete \
    && ln -s "${PACKAGE_DIR}" /out/app

FROM ${NODE_IMAGE}
ENV NODE_ENV=production
RUN apk upgrade --no-cache \
    && rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
    /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack
WORKDIR /srv
COPY --from=deps --chown=node:node /out .
WORKDIR /srv/app
RUN printf '#!/bin/sh\nexec node /srv/app/src/cli.ts "$@"\n' > /usr/local/bin/qtiauth \
    && chmod 755 /usr/local/bin/qtiauth
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:8080/healthz || exit 1
CMD ["node", "src/main.ts"]
