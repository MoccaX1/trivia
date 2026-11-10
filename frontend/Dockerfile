FROM node:26.13.0-bookworm-slim AS development
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
RUN chown node:node /app
USER node
COPY --chown=node:node package.json package-lock.json .npmrc ./
RUN npm ci
COPY --chown=node:node . .
ENV NG_CLI_ANALYTICS=false
CMD ["node", "scripts/dev-server.mjs"]

FROM development AS build
RUN npm run build

FROM development AS browser
USER root
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
RUN npx playwright install --with-deps chromium && apt-get install -y --no-install-recommends libnss3-tools && rm -rf /var/lib/apt/lists/*
USER node
CMD ["sh", "scripts/browser-smoke.sh"]
