# PBI Report Test image for Cloudflare Containers (built by `wrangler deploy`
# from the repository root; see wrangler.jsonc → image_build_context).
FROM mcr.microsoft.com/playwright:v1.65.0-noble

# rclone: sync /data with R2.  sqlite3: consistent online database snapshots.
RUN apt-get update \
 && apt-get install -y --no-install-recommends rclone sqlite3 \
 && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=4400 \
    DATA_DIR=/data \
    HEADLESS=true

# /app and /data belong to the unprivileged user from the start, so nothing needs a
# recursive chown (which would copy node_modules into a second image layer).
RUN mkdir -p /app /data && chown pwuser:pwuser /app /data
USER pwuser
WORKDIR /app
COPY --chown=pwuser:pwuser package.json package-lock.json ./
# The base image ships Chromium for this Playwright version, so the install is
# normally a quick check; it only downloads if the versions ever drift apart.
RUN npm ci --omit=dev --no-audit --no-fund && npx playwright install chromium
COPY --chown=pwuser:pwuser src ./src
COPY --chown=pwuser:pwuser public ./public
COPY --chmod=755 deploy/cloudflare/start.sh /usr/local/bin/pbi-start
EXPOSE 4400
CMD ["/usr/local/bin/pbi-start"]
