FROM node:18-alpine

# Nhận tên thư mục service từ Docker Compose
ARG SERVICE_NAME
WORKDIR /app

# Copy thư mục shared (chứa proto files)
COPY shared ./shared

# Copy package.json và cài đặt thư viện cho service
COPY ${SERVICE_NAME}/package*.json ./${SERVICE_NAME}/
RUN cd ${SERVICE_NAME} && npm install

# Copy toàn bộ mã nguồn của service
COPY ${SERVICE_NAME}/ ./${SERVICE_NAME}/

# Di chuyển workspace vào service và chạy
WORKDIR /app/${SERVICE_NAME}
CMD ["node", "server.js"]