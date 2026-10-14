# syntax=docker/dockerfile:1

# ---- build: compile the server and the web page ---------------------------------------------------
FROM node:22-alpine AS build
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
COPY web ./web
RUN npm run build && npm run build:web && npm prune --omit=dev

# ---- run: only what the server needs, as a user that is not root ------------------------------------
FROM node:22-alpine AS run
ENV NODE_ENV=production
WORKDIR /app

COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/web/dist ./web/dist
COPY --chown=node:node package.json ./
COPY --chown=node:node knowledge ./knowledge

# A folder the server may write to when it keeps its database in a local folder.
RUN mkdir -p /app/.data && chown node:node /app/.data

# Nothing secret is in the image. Settings (tokens, keys, DATABASE_URL) come in as environment
# variables when the container starts.
USER node
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=3s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/server/index.js"]
