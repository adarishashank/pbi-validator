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

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npx playwright install chromium
COPY src ./src
COPY public ./public
COPY deploy/cloudflare/start.sh /usr/local/bin/pbi-start

RUN chmod 755 /usr/local/bin/pbi-start && mkdir -p /data && chown -R pwuser:pwuser /data /app
USER pwuser
EXPOSE 4400
CMD ["/usr/local/bin/pbi-start"]
