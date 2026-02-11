FROM node:18-alpine AS frontend-build

ARG VITE_APP_BASE_URL=/
ARG VITE_API_BASE_URL=
ARG NPM_REGISTRY=https://registry.npmjs.org

WORKDIR /app

COPY apps/frontend/package.json ./
RUN if [ "$NPM_REGISTRY" != "https://registry.npmjs.org" ]; then \
      npm config set registry ${NPM_REGISTRY}; \
    fi \
    && npm install

COPY apps/frontend ./
RUN VITE_APP_BASE_URL=${VITE_APP_BASE_URL} VITE_API_BASE_URL=${VITE_API_BASE_URL} npm run build

FROM nginx:alpine

COPY deploy/nginx/default.conf /etc/nginx/conf.d/default.conf
COPY --from=frontend-build /app/dist /usr/share/nginx/html

EXPOSE 80
