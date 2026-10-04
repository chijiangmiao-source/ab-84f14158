# web 服务镜像：构建页面 + 静态资源服务器（零第三方依赖）
FROM node:20-alpine AS build
WORKDIR /app
COPY engine/ engine/
COPY web/ web/
RUN node web/build.mjs --out /app/web/dist

FROM node:20-alpine
WORKDIR /app
ENV PORT=8080 \
    WEB_ROOT=/app/dist
COPY server/server.mjs server.mjs
COPY --from=build /app/web/dist dist
EXPOSE 8080
CMD ["node", "server.mjs"]
