FROM node:18-alpine

RUN apk add --no-cache wget unzip \
    && wget -qO /tmp/xray.zip https://github.com/XTLS/Xray-core/releases/latest/download/Xray-linux-64.zip \
    && unzip -o /tmp/xray.zip xray -d /usr/local/bin/ \
    && chmod +x /usr/local/bin/xray \
    && rm /tmp/xray.zip \
    && apk del wget unzip

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY src ./src
COPY config ./config

ENV NODE_ENV=production

EXPOSE 3000

CMD ["node", "src/app.js"]
