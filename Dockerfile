# NetNet Loopback liquidator. Build: docker build -t netnetintel-liquidator .
FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force
COPY src ./src
ENV NODE_ENV=production DATA_DIR=/data
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME /data
# the local page: publish it to this computer only (-p 127.0.0.1:8788:8788)
EXPOSE 8788
# healthy while the loop keeps ticking (it touches /data/heartbeat every tick)
HEALTHCHECK --interval=60s --timeout=5s --start-period=180s CMD node -e "process.exit(Date.now()-require('fs').statSync('/data/heartbeat').mtimeMs<120000?0:1)"
ENTRYPOINT ["node", "src/main.mjs"]
CMD ["run"]
