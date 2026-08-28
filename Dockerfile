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

# Verify the image is INTERNALLY CONSISTENT before it ships.
#
# A partial deploy is invisible at build time and brutal at runtime: on
# 2026-08-28 an image went out with a current server.js and a trader-lot-sync.js
# from before syncTraderBanks() moved into it. require() succeeded (the file
# existed), the destructure yielded undefined, and every seller edit saved the
# record and then failed on the bank sync — reported to the operator as an
# error on a save that had actually landed.
#
# server.js degrades rather than dying if this ever slips through, but the
# right place to stop it is HERE: a bad image never ships, and the running
# service is untouched. Same shape as the sql.js check above.
#
# Add a line whenever a cross-file contract is worth guaranteeing at build time.
RUN node -e "\
  const req = { './trader-lot-sync': ['syncLotsFromTrader', 'syncTraderBanks'] }; \
  const bad = []; \
  for (const [mod, names] of Object.entries(req)) { \
    const m = require(mod); \
    for (const n of names) if (typeof m[n] !== 'function') bad.push(mod + ' → ' + n); \
  } \
  if (bad.length) { \
    console.error('INCONSISTENT BUILD — missing exports:\\n  ' + bad.join('\\n  ')); \
    console.error('A stale copy of one of these files is in the build context.'); \
    process.exit(1); \
  } \
  console.log('module contracts OK'); \
"

EXPOSE 3001

CMD ["node", "server.js"]
