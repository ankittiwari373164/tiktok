# Playwright base image ships Chromium + all system libs (matches playwright ^1.60)
FROM mcr.microsoft.com/playwright:v1.60.0-jammy

WORKDIR /app

# Install deps first (better layer caching)
COPY package*.json ./
RUN npm ci --omit=dev || npm install --omit=dev

# Ensure the Chromium browser binary is present
RUN npx playwright install chromium

COPY . .

# Render provides PORT; default 3000 locally
ENV NODE_ENV=production
ENV HEADLESS=true

EXPOSE 3000
CMD ["node", "server.js"]