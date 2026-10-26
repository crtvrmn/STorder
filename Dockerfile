# Storder – selfhosted Lagerkatalog
# Node 24 (bringt node:sqlite mit, kein nativer Build nötig)

FROM node:24-alpine

ENV NODE_ENV=production \
    DATA_DIR=/data \
    PORT=8080 \
    HOST=0.0.0.0

# sharp braucht auf Alpine keine zusätzlichen Systempakete (prebuilt),
# aber tzdata für korrekte Zeitzonen in Datumsausgaben.
RUN apk add --no-cache tzdata

WORKDIR /app

# Nur Manifeste zuerst -> bessere Layer-Caches
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force

COPY --chown=node:node src ./src
COPY --chown=node:node lib ./lib
COPY --chown=node:node public ./public

# Leserechte sicherstellen (Quelldateien können restriktive Rechte haben)
RUN chmod -R a+rX /app

# Persistente Daten (SQLite + Fotos)
RUN mkdir -p /data/photos && chown -R node:node /data
VOLUME ["/data"]

USER node
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "--disable-warning=ExperimentalWarning", "src/server.js"]
