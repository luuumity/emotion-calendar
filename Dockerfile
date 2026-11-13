FROM node:22-bookworm-slim AS build
WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

COPY client/package*.json client/
COPY server/package*.json server/

RUN cd server && npm ci --omit=dev
RUN cd client && npm ci

COPY client client
COPY server server

RUN cd client && npm run build

FROM node:22-bookworm-slim AS runtime
WORKDIR /app

ENV NODE_ENV=production \
    PORT=3001 \
    DB_PATH=/app/server/data/emotion.db \
    JWT_SECRET_FILE=/app/server/data/jwt-secret.txt

COPY --from=build /app/server/package.json server/package.json
COPY --from=build /app/server/node_modules server/node_modules
COPY --from=build /app/server/src server/src
COPY --from=build /app/client/dist client/dist

RUN mkdir -p /app/server/data
EXPOSE 3001

CMD ["node", "server/src/index.js"]
