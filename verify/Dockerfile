# verify 验收镜像：引擎测试 + 页面构建 + 对 web 服务的 HTTP 冒烟
FROM node:20-alpine
WORKDIR /app
COPY engine/ engine/
COPY web/ web/
COPY verify/verify.mjs verify/verify.mjs
ENV WEB_URL=http://web:8080
CMD ["node", "verify/verify.mjs"]
