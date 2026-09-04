FROM node:20-bookworm-slim

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY bridge.js server.js start-all.js ./
COPY public ./public
COPY napcat-openauth-plugin ./napcat-openauth-plugin

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8787 \
    BRIDGE_HOST=127.0.0.1 \
    BRIDGE_PORT=9010

EXPOSE 8787

CMD ["node", "start-all.js"]
