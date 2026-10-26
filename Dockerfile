# syntax=docker/dockerfile:1.7
# Cell AI Voicebot API image (Phase 13 — ADR 0042). Built on the server from a git
# archive (no registry), so it matches the server's CPU. No secrets in any layer: the
# env file is passed to the container at run time.

FROM node:24-bookworm-slim@sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205 AS deps
WORKDIR /app
COPY package.json package-lock.json .npmrc ./
# --ignore-scripts: no git hooks (husky) and no postinstall code from dependencies
RUN npm ci --ignore-scripts --no-audit --no-fund

FROM deps AS build
COPY tsconfig.json tsconfig.build.json tsconfig.ops.json ./
COPY src ./src
COPY scripts ./scripts
RUN npm run build && npm run build:ops

FROM node:24-bookworm-slim@sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205 AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json .npmrc ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY --from=build /app/dist-tools ./dist-tools
COPY package.json ./dist-tools/package.json
COPY docs/samples/knowledge ./dist-tools/docs/samples/knowledge
COPY docs/samples/audio/welcome.wav ./dist-tools/docs/samples/audio/welcome.wav
COPY assets ./assets
ARG GIT_SHA=
ARG BUILT_AT=
ENV GIT_SHA=${GIT_SHA} BUILT_AT=${BUILT_AT}
# Production npm commands use compiled JavaScript, never the development-only tsx.
RUN node -e "const fs=require('fs'),p=require('./package.json');Object.assign(p.scripts,{'db:migrate':'node dist/ops/migrate.js up','db:migrate:down':'node dist/ops/migrate.js down','db:migrate:status':'node dist/ops/migrate.js status','db:sync-indexes':'node dist/ops/sync-indexes.js','analytics:rebuild':'node dist/ops/analytics-rebuild.js','superadmin:create':'node dist/ops/superadmin-create.js','email:test':'node dist/ops/email-test.js','smoke':'node dist-tools/scripts/smoke.js','staging:demo':'node dist-tools/scripts/staging-demo.js'});fs.writeFileSync('package.json',JSON.stringify(p))"
USER node
EXPOSE 5100
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||5100)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/index.js"]
