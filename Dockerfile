FROM node:24-bookworm-slim AS development
RUN apt-get update && apt-get install -y --no-install-recommends git && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig*.json eslint.config.mjs .prettierrc.json .prettierignore .release-it.json ./
COPY src ./src
COPY tests ./tests
COPY scripts ./scripts
CMD ["npm", "run", "dev"]

FROM development AS build
RUN npm run build

FROM node:24-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
USER node
EXPOSE 3000
CMD ["node", "dist/main.js"]
