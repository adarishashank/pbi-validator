# Headless deployment. Interactive sign-in needs a display, so sign in on a
# workstation (`npm run login -- "<profile>"`) and use "Import" on the Auth
# profiles page, or mount the data/auth folder.
FROM mcr.microsoft.com/playwright:v1.65.0-noble

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

RUN mkdir -p /data && chown -R pwuser:pwuser /data /app
USER pwuser
VOLUME ["/data"]
EXPOSE 4400
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://127.0.0.1:4400/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "--disable-warning=ExperimentalWarning", "src/server.js"]
