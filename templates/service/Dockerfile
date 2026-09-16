ARG NODE_IMAGE=node:26.8.2-alpine3.24

FROM ${NODE_IMAGE} AS deps
ARG PACKAGE=@qtiauth/template-service
ARG PACKAGE_DIR=templates/service
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
WORKDIR /srv
COPY --from=deps --chown=node:node /out .
WORKDIR /srv/app
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:8080/healthz || exit 1
CMD ["node", "src/main.ts"]
