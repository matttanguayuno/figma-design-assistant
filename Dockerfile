FROM node:18-slim

# Install Chrome dependencies + Chrome itself
RUN apt-get update && apt-get install -y --no-install-recommends \
    wget gnupg ca-certificates \
  && wget -q -O - https://dl.google.com/linux/linux_signing_key.pub | gpg --dearmor -o /usr/share/keyrings/google-chrome.gpg \
  && echo "deb [arch=amd64 signed-by=/usr/share/keyrings/google-chrome.gpg] http://dl.google.com/linux/chrome/deb/ stable main" > /etc/apt/sources.list.d/google-chrome.list \
  && apt-get update && apt-get install -y --no-install-recommends google-chrome-stable \
  && apt-get clean && rm -rf /var/lib/apt/lists/*

# Set Chrome path for puppeteer-core
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/google-chrome-stable

WORKDIR /app

# Install ALL dependencies (need esbuild devDep for build step)
COPY package.json package-lock.json* ./
RUN npm install

# Copy source and build
COPY . .
RUN npm run build:backend

# Prune dev dependencies for smaller image
RUN npm prune --production

EXPOSE 10000

CMD ["node", "dist/server.js"]
