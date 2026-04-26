FROM node:20-slim AS builder

WORKDIR /build
COPY package.json package-lock.json* tsconfig.json ./
RUN npm ci --include=dev
COPY src ./src
RUN npm run build

# ---------------------------------------------------------------------------
# Runtime image — Chrome stable + production deps only.
# ---------------------------------------------------------------------------
FROM node:20-slim

# Install Chrome stable and the font packages Puppeteer needs to render
# realistic invoices. Slim image keeps the surface area small.
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
       wget gnupg ca-certificates \
  && wget -q -O - https://dl.google.com/linux/linux_signing_key.pub \
       | gpg --dearmor -o /usr/share/keyrings/googlechrome-linux-keyring.gpg \
  && echo "deb [arch=amd64 signed-by=/usr/share/keyrings/googlechrome-linux-keyring.gpg] http://dl.google.com/linux/chrome/deb/ stable main" \
       > /etc/apt/sources.list.d/google-chrome.list \
  && apt-get update \
  && apt-get install -y --no-install-recommends \
       google-chrome-stable \
       fonts-liberation fonts-noto-color-emoji fonts-noto-cjk \
       libxss1 libnss3 libgbm1 \
  && rm -rf /var/lib/apt/lists/*

# Run as non-root for the sandbox.
RUN groupadd -r pdf && useradd -r -g pdf -G audio,video pdf \
  && mkdir -p /home/pdf/Downloads /app \
  && chown -R pdf:pdf /home/pdf /app

WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=builder /build/dist ./dist
COPY src/templates ./dist/templates

USER pdf

ENV NODE_ENV=production
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/google-chrome-stable
ENV PORT=8080
EXPOSE 8080

CMD ["node", "dist/index.js"]
