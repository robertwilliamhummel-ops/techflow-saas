FROM node:24-slim AS builder

WORKDIR /build
COPY package.json package-lock.json* tsconfig.json ./
RUN npm ci --include=dev
COPY src ./src
RUN npm run build

# ---------------------------------------------------------------------------
# Runtime image — production deps, Chrome for Testing, fonts.
# ---------------------------------------------------------------------------
FROM node:24-slim

# Run as non-root for the sandbox.
RUN groupadd -r pdf && useradd -r -g pdf -G audio,video pdf \
  && mkdir -p /home/pdf/Downloads /app \
  && chown -R pdf:pdf /home/pdf /app

WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev && npm cache clean --force

# Chrome for Testing, pinned to the exact build this puppeteer-core release is
# tested against (pptr.dev/supported-browsers), installed with Puppeteer's own
# @puppeteer/browsers CLI; --install-deps adds the shared libraries Chrome needs
# on Debian. An unpinned google-chrome-stable could move ahead of puppeteer-core
# between image builds (U-02). The fonts render realistic invoices.
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
       ca-certificates fonts-liberation fonts-noto-color-emoji fonts-noto-cjk \
  && CHROME_BUILD="$(node -p "require('puppeteer-core/internal/revisions.js').PUPPETEER_REVISIONS.chrome")" \
  && CHROME_PATH="$(node node_modules/@puppeteer/browsers/lib/main-cli.js install "chrome@${CHROME_BUILD}" --path /opt/chrome --install-deps --format '{{path}}' | tail -n 1)" \
  && test -x "${CHROME_PATH}" \
  && ln -s "${CHROME_PATH}" /usr/local/bin/chrome \
  && rm -rf /var/lib/apt/lists/*

COPY --from=builder /build/dist ./dist
COPY src/templates ./dist/templates

USER pdf

ENV NODE_ENV=production
ENV PUPPETEER_EXECUTABLE_PATH=/usr/local/bin/chrome
ENV PORT=8080
EXPOSE 8080

CMD ["node", "dist/index.js"]
