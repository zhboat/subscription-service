FROM node:18-alpine

ARG NPM_REGISTRY=https://registry.npmjs.org
ARG GITHUB_PROXY=

RUN apk add --no-cache wget unzip \
    && wget -qO /tmp/xray.zip ${GITHUB_PROXY}https://github.com/XTLS/Xray-core/releases/latest/download/Xray-linux-64.zip \
    && unzip -o /tmp/xray.zip xray -d /usr/local/bin/ \
    && chmod +x /usr/local/bin/xray \
    && rm /tmp/xray.zip \
    && apk del wget unzip

WORKDIR /app

COPY package.json package-lock.json* ./
RUN if [ "$NPM_REGISTRY" != "https://registry.npmjs.org" ]; then \
      npm config set registry ${NPM_REGISTRY}; \
    fi \
    && if [ -f package-lock.json ]; then npm ci --omit=dev; else npm install --omit=dev; fi

COPY src ./src
COPY scripts ./scripts
COPY config ./config

ENV NODE_ENV=production

EXPOSE 3000

CMD ["node", "src/app.js"]
