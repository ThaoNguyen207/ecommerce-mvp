# Ecommerce MVP Microservices Application

Hệ thống E-Commerce kiến trúc Microservices xây dựng bằng Node.js, Express, gRPC, Apache Kafka, Redis, PostgreSQL và MongoDB.

## 🏗️ Kiến trúc hệ thống

```
                                  ┌────────────────────────┐
                                  │   Client / Postman     │
                                  └───────────┬────────────┘
                                              │ HTTP / REST
                                              ▼
                                  ┌────────────────────────┐
                                  │      API Gateway       │
                                  │    (Express + Redis)   │
                                  └───┬────┬────┬────┬─────┘
                                      │    │    │    │ gRPC
         ┌────────────────────────────┘    │    │    └────────────────────────────┐
         ▼                                 ▼    ▼                                 ▼
┌─────────────────┐             ┌─────────────────┐             ┌─────────────────┐             ┌─────────────────┐
│  Auth Service   │             │Customer Service │             │ Product Service │             │  Order Service  │
│  (PostgreSQL)   │             │  (PostgreSQL)   │             │    (MongoDB)    │             │  (PostgreSQL)   │
└─────────────────┘             └─────────────────┘             └─────────────────┘             └────────┬────────┘
                                                                                                         │ Kafka Event
                                                                                                         ▼
                                                                                                ┌─────────────────┐
                                                                                                │Shipment Service │
                                                                                                │(MongoDB + Kafka)│
                                                                                                └─────────────────┘
```

## 🚀 Công nghệ sử dụng

- **API Gateway**: Node.js, Express, Redis, gRPC client
- **Microservices**: Node.js, `@grpc/grpc-js`, `@grpc/proto-loader`
- **Inter-service Communication**: gRPC (Protobuf), Apache Kafka (Event-driven)
- **Databases**:
  - PostgreSQL (Auth, Customer, Order)
  - MongoDB (Product, Shipment)
  - Redis (Caching / Token Blacklist)
- **Message Broker**: Apache Kafka & Zookeeper
- **DevOps**: Docker, Docker Compose

## 📁 Cấu trúc thư mục

```
ecommerce-mvp/
├── api-gateway/          # REST API Gateway định tuyến tới các gRPC service
├── auth-service/         # Dịch vụ xác thực người dùng (gRPC + PostgreSQL)
├── customer-service/     # Quản lý hồ sơ khách hàng (gRPC + PostgreSQL)
├── product-service/      # Quản lý danh mục sản phẩm (gRPC + MongoDB)
├── order-service/        # Quản lý đơn hàng (gRPC + PostgreSQL + Kafka Producer)
├── shipment-service/     # Quản lý vận chuyển (gRPC + MongoDB + Kafka Consumer)
├── shared/proto/         # Protobuf contract definitions
├── docker-compose.infra.yml # Khởi động hạ tầng: Postgres, Mongo, Redis, Kafka, Zookeeper
├── docker-compose.yml    # Khởi động toàn bộ microservices
├── init-databases.sql    # Khởi tạo database cho PostgreSQL
└── Ecommerce_MVP_Microservices.postman_collection.json # Bộ test Postman API
```

## 🛠️ Hướng dẫn cài đặt & Khởi chạy

### 1. Khởi động hạ tầng (Infrastructure)

Chạy cơ sở dữ liệu và message broker bằng Docker Compose:

```bash
docker compose -f docker-compose.infra.yml up -d
```

Hạ tầng bao gồm:
- PostgreSQL (`localhost:5432`)
- MongoDB (`localhost:27017`)
- Redis (`localhost:6379`)
- Kafka Broker (`localhost:9092`) & Zookeeper (`localhost:2181`)

### 2. Cài đặt biến môi trường

Sao chép `.env.example` thành `.env` trong từng thư mục service:
- `api-gateway/.env`
- `auth-service/.env`
- `customer-service/.env`
- `order-service/.env`
- `product-service/.env`
- `shipment-service/.env`

### 3. Cài đặt dependencies cho từng service

```bash
cd api-gateway && npm install && cd ..
cd auth-service && npm install && cd ..
cd customer-service && npm install && cd ..
cd product-service && npm install && cd ..
cd order-service && npm install && cd ..
cd shipment-service && npm install && cd ..
```

### 4. Khởi chạy toàn bộ hệ thống bằng Docker Compose

```bash
docker compose up -d --build
```

Hoặc khởi chạy từng service độc lập với lệnh `node server.js` trong từng thư mục service.

### 5. Kiểm thử với Postman

Import file `Ecommerce_MVP_Microservices.postman_collection.json` vào Postman để gọi thử các API Gateway tại `http://localhost:3000`.
