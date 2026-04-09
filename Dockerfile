FROM node:20-alpine AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci
COPY tsconfig.json tsconfig.server.json ./
COPY server.ts ./
COPY lib/ ./lib/
RUN npx tsc -p tsconfig.server.json && cp lib/oauth-success.html dist/lib/ 2>/dev/null || true

FROM node:20-alpine
WORKDIR /app
COPY --from=build /app/dist ./dist
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./
EXPOSE 8080
ENV PORT=8080
CMD ["node", "dist/server.js"]
