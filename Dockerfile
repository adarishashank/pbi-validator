# Headless deployment. Interactive sign-in needs a display, so sign in on a
# workstation (`npm run login -- "<profile>"`) and use "Import" on the Auth
# profiles page, or mount the data/auth folder.
FROM mcr.microsoft.com/playwright:v1.65.0-noble

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=4400 \
    DATA_DIR=/data \
    HEADLESS=true

RUN mkdir -p /app /data && chown pwuser:pwuser /app /data
USER pwuser
WORKDIR /app
COPY --chown=pwuser:pwuser package.json package-lock.json ./
# The base image ships Chromium for this Playwright version, so the install is
# normally a quick check; it only downloads if the versions ever drift apart.
RUN npm ci --omit=dev --no-audit --no-fund && npx playwright install chromium
COPY --chown=pwuser:pwuser src ./src
COPY --chown=pwuser:pwuser public ./public
VOLUME ["/data"]
EXPOSE 4400
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://127.0.0.1:4400/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "--disable-warning=ExperimentalWarning", "src/server.js"]
