# Spice Config — Railway Dockerfile (sql.js variant)
# No native compilation required — sql.js is pure JavaScript with WASM.
# Much simpler and more reliable than the better-sqlite3 path.

FROM node:20-bookworm-slim

# Shared libraries headless Chromium (@sparticuz/chromium) needs at runtime for
# the HTML invoice engine (INVOICE_ENGINE / *_engine = html). Without these the
# browser process fails to launch ("error while loading shared libraries:
# libnspr4.so"). Kept as an early layer so it caches across app rebuilds.
RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      libnspr4 libnss3 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 \
      libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 libgbm1 \
      libasound2 libpango-1.0-0 libcairo2 libatspi2.0-0 libxext6 libxrender1 \
      libxi6 libxtst6 fonts-liberation \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy package.json (no package-lock — Railway gets a clean install)
COPY package.json ./

# Install only runtime deps. better-sqlite3 is in optionalDependencies
# and will be skipped if compilation fails (or via the flag below).
ENV NPM_CONFIG_OPTIONAL=false
RUN npm install --omit=dev

# Verify sql.js loads
RUN node -e "require('sql.js')().then(SQL => { new SQL.Database(); console.log('sql.js OK'); });"

# Copy app source (after deps so Docker caches deps separately)
COPY . .

# Strip build artifacts
RUN rm -rf data/ electron/ *.zip BUILD.md RELEASE.md MIGRATION.md \
    && rm -f recover-isp.js

EXPOSE 3001

CMD ["node", "server.js"]
