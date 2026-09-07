FROM node:20-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build 2>/dev/null || npx tsc

FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY --from=builder /app/dist ./dist
# The commit this image was built from, reported by GET /health, by /status and
# by `flyctl image show` (the label), which were the three places that could not
# name it. Declared LAST on purpose: this value changes on every deploy, and an
# ENV above the install would invalidate the dependency layer every time.
# Defaulted, so a bare `flyctl deploy` still builds and honestly says "unknown"
# rather than naming a commit it does not contain. Use `npm run deploy`.
ARG GIT_SHA=unknown
ENV GIT_SHA=$GIT_SHA
LABEL org.opencontainers.image.revision=$GIT_SHA
EXPOSE 3000
CMD ["node", "dist/server.js"]
