# passport-funder — any always-on Node host will do. NOT serverless: the
# wallet keeps a live indexer subscription and must stay synced between drips.
FROM node:22-slim

WORKDIR /app

COPY package.json ./
RUN npm install

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# The sync snapshot and the once-only drip ledger live here — mount a volume
# so restarts neither re-walk the chain nor forget who was already activated.
ENV FUNDER_STATE_DIR=/data
RUN mkdir -p /data && chown -R node:node /data /app
VOLUME /data

# Nothing here needs root: the service opens one port above 1024 and writes
# only to its state directory. The base image ships an unprivileged `node`
# user, so a process that escapes the service does not inherit the container.
USER node

EXPOSE 8799
CMD ["node", "dist/server.mjs"]
