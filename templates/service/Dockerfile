ARG NODE_IMAGE=node:26.8.2-alpine3.24

FROM ${NODE_IMAGE} AS deps
RUN npm install --global pnpm@12.4.2
WORKDIR /repo
COPY . .
RUN pnpm install --frozen-lockfile \
    && pnpm --filter @qtiauth/template-service deploy --prod /out

FROM ${NODE_IMAGE}
ENV NODE_ENV=production
WORKDIR /app
COPY --from=deps --chown=node:node /out .
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:8080/healthz || exit 1
CMD ["node", "src/main.ts"]
