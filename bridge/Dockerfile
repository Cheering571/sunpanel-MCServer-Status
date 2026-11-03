# Minecraft 状态桥接服务
#
# dig 用来查 SRV 记录（很多公网服务器只配 SRV），所以不能只用 scratch/alpine 裸镜像
FROM python:3.11-alpine

# bind-tools 提供 dig
RUN apk add --no-cache bind-tools

WORKDIR /app
COPY bridge.py .

EXPOSE 8848

# --cache 3：同一地址 3 秒内复用结果，避免重复 ping
# --retry 1：FRP 后面首次连接可能较慢，失败重试一次
CMD ["python3", "bridge.py", "--host", "0.0.0.0", "--port", "8848", "--cache", "3", "--retry", "1"]
