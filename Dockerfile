# 零依赖，无需 npm install 阶段
FROM node:22-alpine

WORKDIR /app
ENV NODE_ENV=production \
    PORT=8790 \
    EVENT_DIR=/data/runs \
    SKILLS_DIR=/app/examples/skills

COPY package.json ./
COPY src ./src
COPY examples ./examples

RUN mkdir -p /data/runs && addgroup -S app && adduser -S app -G app && chown -R app:app /app /data
USER app

EXPOSE 8790
VOLUME ["/data"]

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8790)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/server.mjs"]
