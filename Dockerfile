# Zero runtime dependencies: no npm install step. Build context = repository root (or the dist/ folder produced by `npm run build`).
FROM node:22-alpine
ENV NODE_ENV=production PORT=8080 HOST=0.0.0.0 DATA_DIR=/data
WORKDIR /app
COPY package.json ./
COPY src ./src
COPY docs ./docs
RUN mkdir -p /data && chown -R node:node /data /app
USER node
EXPOSE 8080
VOLUME ["/data"]
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
# Set API_TOKEN to enable the instructor endpoints; terminate TLS in a reverse proxy (see docs/DEPLOYMENT.md).
CMD ["node", "src/server/server.js"]
