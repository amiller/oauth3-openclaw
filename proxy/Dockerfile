FROM node:22-slim

WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build && npm prune --production

ENV NODE_ENV=production
ENV PORT=3737
ENV DB_PATH=/data/proxy.db

EXPOSE 3737
CMD ["node", "dist/server.js"]
