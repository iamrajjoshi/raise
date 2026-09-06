FROM node:24-bookworm-slim AS build

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable && corepack prepare pnpm@11.19.0 --activate

WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.json tsconfig.base.json ./
COPY apps ./apps
COPY packages ./packages
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @raise/protocol build && pnpm --filter @raise/web build && pnpm --filter @raise/server build
RUN CI=true pnpm --config.inject-workspace-packages=true --filter @raise/server deploy --prod /prod/server

FROM node:24-bookworm-slim AS runtime

ENV NODE_ENV=production
ENV PORT=8787
ENV PUBLIC_BASE_URL=http://localhost:8787
ENV DATA_DIR=/data

WORKDIR /app
COPY --from=build /prod/server ./apps/server
COPY --from=build /app/apps/web/dist ./apps/web/dist

RUN mkdir -p /data/blobs && chown -R node:node /data /app
USER node

EXPOSE 8787
VOLUME ["/data"]
HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=5 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:8787/readyz').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]

CMD ["node", "apps/server/dist/main.js"]
