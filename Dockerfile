# Node 22, and now it is a choice rather than a constraint.
#
# Node 20 reached end of life on 2026-04-30 and is no longer in the CI runner's
# tool cache, which is what forced the move off it. The reason this landed on 22
# instead of 24 was Fastify 4: its LTS table listed "14, 16, 18, 20, 22" and
# only listed 24 from v5 onward. That constraint is gone — this app is on
# Fastify 5 now, and 24 is supported.
#
# It stays on 22 anyway, for two reasons that are about risk and not about
# support. 22 is an active LTS until 2027-04-30, so nothing is expiring. And
# moving the framework and the runtime in one change would leave any regression
# with two candidate causes; the Node 20 to 22 move was deployed and verified
# hours before this, and re-opening it here buys nothing.
#
# Revisit before 2027-04-30. Change these two lines and the ci.yml pins
# together, or CI stops testing what production runs.
FROM node:22-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build 2>/dev/null || npx tsc

FROM node:22-alpine
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
