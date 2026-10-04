# 零依赖 Node 应用：无需 npm install
FROM node:20-bookworm-slim

WORKDIR /app

# 先拷贝源码并在构建期完成页面构建，使健康检查可真实反映静态资源可用
COPY package.json ./
COPY src ./src
COPY server.js ./
COPY scripts ./scripts
COPY test ./test

RUN node scripts/build.js

ENV NODE_ENV=production \
    PORT=8080 \
    HOST=0.0.0.0

EXPOSE 8080

# 容器存活探针直接读取健康端点（其结果随静态资源可用性变化）
HEALTHCHECK --interval=10s --timeout=3s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
