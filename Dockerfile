# Node 22, not 24, and the reason is Fastify rather than Node.
#
# Node 20 reached end of life on 2026-04-30 and is no longer in the CI runner's
# tool cache, which is what forced this move. Node 24 has a year more runway
# (ends 2028-04-30 against 22's 2027-04-30) and was tested here and works, but
# fastify's own LTS table lists v4 as supporting "14, 16, 18, 20, 22" and only
# lists 24 from v5 onward. This app is pinned to fastify 4.29.1, which is the
# final 4.x release and went end of LTS on 2025-06-30, so it can never gain
# that support. Running it on 24 would stack an untested Node line under an
# unmaintained framework to buy twelve months.
#
# The move to 24 or 26 is the Fastify 5 upgrade, and it is due before
# 2027-04-30. Change these two lines and the ci.yml pins together, or CI stops
# testing what production runs.
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
