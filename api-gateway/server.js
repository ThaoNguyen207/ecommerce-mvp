require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { createClient } = require('redis');
const rateLimit = require('express-rate-limit');
const { RedisStore } = require('rate-limit-redis');
const grpc = require('@grpc/grpc-js');
const protoLoader = require('@grpc/proto-loader');
const path = require('path');
const morgan = require('morgan');

const app = express();
app.use(express.json());
app.use(cors());

// 1. Logging (Ghi log mọi HTTP request vào console)
app.use(morgan('dev'));

// 2. Kết nối Redis (Dùng cho Cache và Rate Limiting)
const redisClient = createClient({
    url: process.env.REDIS_URL || 'redis://redis:6379'
});
redisClient.on('error', (err) => console.error('❌ Redis Error in Gateway:', err));
redisClient.connect().then(() => console.log('✅ Connected to Redis successfully!'));

// 3. Rate Limiting sử dụng Redis Store theo đúng yêu cầu đề bài
const apiLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 phút
    max: 100, // Tối đa 100 requests / 15 phút cho mỗi IP
    standardHeaders: true,
    legacyHeaders: false,
    store: new RedisStore({
        sendCommand: (...args) => redisClient.sendCommand(args),
    }),
    message: { success: false, message: 'Too many requests from this IP, please try again later.' }
});
app.use('/api/', apiLimiter);

// 4. Load gRPC Clients
const loadProto = (filename) => grpc.loadPackageDefinition(
    protoLoader.loadSync(path.join(__dirname, '../shared/proto', filename), {
        keepCase: true, longs: String, enums: String, defaults: true, oneofs: true
    })
);

const authClient = new (loadProto('auth.proto').auth).AuthService(
    process.env.AUTH_SERVICE_URL || 'auth-service:50051',
    grpc.credentials.createInsecure()
);
const customerClient = new (loadProto('customer.proto').customer).CustomerService(
    process.env.CUSTOMER_SERVICE_URL || 'customer-service:50052',
    grpc.credentials.createInsecure()
);
const productClient = new (loadProto('product.proto').product).ProductService(
    process.env.PRODUCT_SERVICE_URL || 'product-service:50053',
    grpc.credentials.createInsecure()
);
const orderClient = new (loadProto('order.proto').order).OrderService(
    process.env.ORDER_SERVICE_URL || 'order-service:50054',
    grpc.credentials.createInsecure()
);
const shipmentClient = new (loadProto('shipment.proto').shipment).ShipmentService(
    process.env.SHIPMENT_SERVICE_URL || 'shipment-service:50055',
    grpc.credentials.createInsecure()
);

// 5. Middleware Xác thực JWT (Authentication)
const authenticateJWT = (req, res, next) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ success: false, message: 'Missing or invalid Authorization header' });
    }
    
    const token = authHeader.split(' ')[1];
    authClient.ValidateToken({ token }, (err, response) => {
        if (err || !response || !response.valid) {
            return res.status(401).json({ success: false, message: 'Unauthorized / Invalid Token' });
        }
        req.user = { uid: response.uid, roleid: response.roleid };
        next();
    });
};

// 6. Middleware Phân quyền (Authorization: 1 = ADMIN, 2 = USER)
const authorizeRole = (allowedRoleIds) => {
    return (req, res, next) => {
        if (!req.user || !allowedRoleIds.includes(req.user.roleid)) {
            return res.status(403).json({
                success: false,
                message: 'Forbidden: You do not have permission to access this resource'
            });
        }
        next();
    };
};

// ==================== RESTful API ROUTES ====================

// --- 7. Health Check ---
app.get('/health', async (req, res) => {
    res.status(200).json({
        status: 'UP',
        service: 'API-Gateway',
        timestamp: new Date().toISOString(),
        redis: redisClient.isReady ? 'CONNECTED' : 'DISCONNECTED',
        services: {
            auth: 'auth-service:50051',
            customer: 'customer-service:50052',
            product: 'product-service:50053',
            order: 'order-service:50054',
            shipment: 'shipment-service:50055'
        }
    });
});

// --- 8. Auth Routes ---
app.post('/api/auth/register', (req, res) => {
    const { username, password, fullname } = req.body;
    authClient.Register({ username, password }, (err, response) => {
        if (err) return res.status(500).json({ success: false, message: err.message });
        if (!response.success) return res.status(400).json(response);

        // Tự động khởi tạo Customer Profile nếu có cung cấp fullname
        if (fullname) {
            customerClient.CreateCustomerProfile({ uid: response.uid, fullname }, (cErr) => {
                if (cErr) console.error('Error auto-creating customer profile:', cErr);
            });
        }

        res.status(201).json(response);
    });
});

app.post('/api/auth/login', (req, res) => {
    authClient.Login(req.body, (err, response) => {
        if (err) return res.status(500).json({ success: false, message: err.message });
        res.status(response.success ? 200 : 401).json(response);
    });
});

// --- 9. Customer Routes (Quản lý khách hàng, điểm score và hạng thành viên) ---
app.post('/api/customers', authenticateJWT, (req, res) => {
    const data = {
        uid: req.body.uid || req.user.uid,
        fullname: req.body.fullname
    };
    customerClient.CreateCustomerProfile(data, (err, response) => {
        if (err) return res.status(500).json({ success: false, message: err.message });
        res.status(response.success ? 201 : 400).json(response);
    });
});

app.get('/api/customers/:uid', authenticateJWT, (req, res) => {
    const uid = parseInt(req.params.uid, 10);
    customerClient.GetCustomerInfo({ uid }, (err, response) => {
        if (err) return res.status(500).json({ success: false, message: err.message });
        res.status(response.success ? 200 : 404).json(response);
    });
});

// Cập nhật điểm score và hạng thành viên (Phân quyền: Chỉ ADMIN hoặc nội bộ hệ thống)
app.put('/api/customers/:uid/score', authenticateJWT, authorizeRole([1]), (req, res) => {
    const uid = parseInt(req.params.uid, 10);
    const score = parseInt(req.body.score, 10);
    customerClient.UpdateCustomerScore({ uid, score }, (err, response) => {
        if (err) return res.status(500).json({ success: false, message: err.message });
        res.status(response.success ? 200 : 400).json(response);
    });
});

// --- 10. Product Routes ---
// Tạo sản phẩm (Phân quyền: Chỉ ADMIN - roleid 1)
app.post('/api/products', authenticateJWT, authorizeRole([1]), (req, res) => {
    productClient.CreateProduct(req.body, async (err, response) => {
        if (err) return res.status(500).json({ success: false, message: err.message });
        if (response.success && req.body.pid) {
            // Xóa cache cũ nếu có
            await redisClient.del(`product:${req.body.pid}`);
        }
        res.status(response.success ? 201 : 400).json(response);
    });
});

// Lấy danh sách tất cả sản phẩm (TC-PRO-01)
app.get('/api/products', (req, res) => {
    productClient.GetAllProducts({}, (err, response) => {
        if (err) return res.status(500).json({ success: false, message: err.message });
        res.status(200).json(response);
    });
});

// Lấy chi tiết sản phẩm (Có tích hợp Redis Cache)
app.get('/api/products/:pid', async (req, res) => {
    const pid = parseInt(req.params.pid, 10);
    const cacheKey = `product:${pid}`;
    
    try {
        // 1. Kiểm tra cache
        const cachedData = await redisClient.get(cacheKey);
        if (cachedData) {
            return res.status(200).json({ ...JSON.parse(cachedData), _source: 'REDIS_CACHE' });
        }

        // 2. Cache miss -> gọi sang Product Service
        productClient.GetProduct({ pid }, async (err, response) => {
            if (err) return res.status(500).json({ success: false, message: err.message });
            if (!response.success) return res.status(404).json(response);
            
            // 3. Ghi vào Redis Cache trong 1 giờ (3600s)
            await redisClient.setEx(cacheKey, 3600, JSON.stringify(response));
            res.status(200).json({ ...response, _source: 'DATABASE' });
        });
    } catch (error) {
        res.status(500).json({ success: false, message: "Internal cache error: " + error.message });
    }
});

// --- 11. Order Routes ---
// Đặt hàng (Yêu cầu xác thực JWT)
app.post('/api/orders', authenticateJWT, (req, res) => {
    // Tự động gán uid từ JWT token đã xác thực
    const orderData = {
        uid: req.user.uid,
        items: req.body.items
    };
    
    orderClient.CreateOrder(orderData, async (err, response) => {
        if (err) return res.status(500).json({ success: false, message: err.message });
        if (response.success && req.body.items) {
            for (let item of req.body.items) {
                try {
                    await redisClient.del(`product:${item.pid}`);
                } catch (cErr) {
                    console.error('Error invalidating product cache:', cErr);
                }
            }
        }
        res.status(response.success ? 201 : 400).json(response);
    });
});

// --- 12. Shipment Routes (Cập nhật và tra cứu trạng thái giao hàng) ---
// Cập nhật trạng thái giao hàng (Phân quyền: Chỉ ADMIN/Vận chuyển - roleid 1)
app.patch('/api/shipments/:shipid/status', authenticateJWT, authorizeRole([1]), (req, res) => {
    const shipid = parseInt(req.params.shipid, 10);
    const { status } = req.body;
    shipmentClient.UpdateShipmentStatus({ shipid, status }, (err, response) => {
        if (err) return res.status(500).json({ success: false, message: err.message });
        res.status(response.success ? 200 : 400).json(response);
    });
});

// Tra cứu vận chuyển theo đơn hàng (Order ID)
app.get('/api/shipments/order/:oid', authenticateJWT, (req, res) => {
    const oid = parseInt(req.params.oid, 10);
    shipmentClient.GetShipmentByOrderId({ oid }, (err, response) => {
        if (err) return res.status(500).json({ success: false, message: err.message });
        res.status(response.success ? 200 : 404).json(response);
    });
});

// Tra cứu vận chuyển theo Ship ID
app.get('/api/shipments/:shipid', authenticateJWT, (req, res) => {
    const shipid = parseInt(req.params.shipid, 10);
    shipmentClient.GetShipmentById({ shipid }, (err, response) => {
        if (err) return res.status(500).json({ success: false, message: err.message });
        res.status(response.success ? 200 : 404).json(response);
    });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 API Gateway is running on port ${PORT}`));