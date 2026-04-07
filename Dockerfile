FROM node:20-bookworm-slim

# Install Chromium and minimal dependencies
RUN apt-get update && apt-get install -y \
    chromium \
    fonts-ipafont-gothic \
    fonts-wqy-zenhei \
    fonts-thai-tlwg \
    fonts-kacst \
    fonts-freefont-ttf \
    --no-install-recommends \
    && rm -rf /var/lib/apt/lists/* \
    && rm -rf /tmp/*

# Tell Puppeteer to use system Chromium
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

# Create app directory
WORKDIR /app

# Copy package files first (Docker layer caching)
COPY package.json package-lock.json ./

# Install production dependencies only, skip Puppeteer's Chrome download
RUN npm ci --omit=dev --ignore-scripts

# Copy all app files
COPY public ./public
COPY server ./server

# Verify files are in place
RUN echo "=== Build verification ===" && \
    ls -la /app/ && \
    echo "=== Public files ===" && \
    ls -la /app/public/ && \
    echo "=== Server files ===" && \
    ls -la /app/server/

# Expose port
EXPOSE 3000

ENV NODE_ENV=production
ENV PORT=3000

CMD ["node", "server/index.js"]