require('dotenv').config();
const grpc = require('@grpc/grpc-js');
const protoLoader = require('@grpc/proto-loader');
const { Pool } = require('pg');
const { Kafka } = require('kafkajs');
const path = require('path');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const initDB = async () => {
    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS "order" (
                oid SERIAL PRIMARY KEY,
                uid INT NOT NULL,
                discount DECIMAL(10,2) NOT NULL DEFAULT 0,
                total_amount DECIMAL(10,2) NOT NULL
            );
            CREATE TABLE IF NOT EXISTS orderdetail (
                oid INT REFERENCES "order"(oid),
                pid INT NOT NULL,
                qty INT NOT NULL,
                unit_price DECIMAL(10,2) NOT NULL,
                PRIMARY KEY (oid, pid)
            );
        `);
        console.log('✅ Order Database tables initialized successfully.');
    } catch (err) {
        console.error('❌ Database initialization error:', err);
    }
};

const kafka = new Kafka({ clientId: 'order-service', brokers: [process.env.KAFKA_BROKER || 'localhost:9092'] });
const producer = kafka.producer();

const loadProto = (filename) => {
    const PROTO_PATH = path.join(__dirname, '../shared/proto', filename);
    return grpc.loadPackageDefinition(protoLoader.loadSync(PROTO_PATH, {
        keepCase: true, longs: String, enums: String, defaults: true, oneofs: true
    }));
};

const orderProto = loadProto('order.proto').order;
const customerProto = loadProto('customer.proto').customer;
const productProto = loadProto('product.proto').product;

// ĐÃ SỬA THÀNH TÊN CONTAINER DOCKER
const customerClient = new customerProto.CustomerService('customer-service:50052', grpc.credentials.createInsecure());
const productClient = new productProto.ProductService('product-service:50053', grpc.credentials.createInsecure());

const getCustomerInfo = (uid) => new Promise((resolve, reject) => {
    customerClient.GetCustomerInfo({ uid }, (err, res) => err ? reject(err) : resolve(res));
});
const getProductInfo = (pid) => new Promise((resolve, reject) => {
    productClient.GetProduct({ pid }, (err, res) => err ? reject(err) : resolve(res));
});
const decreaseQuantity = (pid, qty) => new Promise((resolve, reject) => {
    productClient.DecreaseQuantity({ pid, quantity_to_deduct: qty }, (err, res) => err ? reject(err) : resolve(res));
});

const CreateOrder = async (call, callback) => {
    const { uid, items } = call.request;
    const client = await pool.connect();
    
    try {
        await client.query('BEGIN');
        const customerRes = await getCustomerInfo(uid);
        if (!customerRes.success) throw new Error("Customer not found");
        
        let discountPercent = 0;
        if (customerRes.score >= 100) discountPercent = 0.10;
        else if (customerRes.score >= 50) discountPercent = 0.05;

        let rawTotal = 0;
        const orderDetails = [];

        for (let item of items) {
            const prodRes = await getProductInfo(item.pid);
            if (!prodRes.success) throw new Error(`Product ${item.pid} not found`);
            if (prodRes.quantity < item.qty) throw new Error(`Not enough stock for product ${item.pid} (Available: ${prodRes.quantity})`);

            const unitPrice = prodRes.price;
            rawTotal += unitPrice * item.qty;
            orderDetails.push({ pid: item.pid, qty: item.qty, unitPrice });

            const deductRes = await decreaseQuantity(item.pid, item.qty);
            if (!deductRes.success) throw new Error(`Failed to deduct stock for ${item.pid}`);
        }

        const discountAmount = rawTotal * discountPercent;
        const finalTotal = rawTotal - discountAmount;

        const orderResult = await client.query(
            'INSERT INTO "order" (uid, discount, total_amount) VALUES ($1, $2, $3) RETURNING oid',
            [uid, discountAmount, finalTotal]
        );
        const oid = orderResult.rows[0].oid;

        for (let detail of orderDetails) {
            await client.query(
                'INSERT INTO orderdetail (oid, pid, qty, unit_price) VALUES ($1, $2, $3, $4)',
                [oid, detail.pid, detail.qty, detail.unitPrice]
            );
        }

        await client.query('COMMIT');

        await producer.send({
            topic: 'order-created',
            messages: [{ value: JSON.stringify({ oid, uid, total_amount: finalTotal, status: 'PENDING' }) }]
        });
        console.log(`📤 Published OrderCreated event for Order ID: ${oid}`);

        callback(null, { success: true, message: "Order created successfully", oid, discount: discountAmount, total_amount: finalTotal });
    } catch (error) {
        await client.query('ROLLBACK');
        callback(null, { success: false, message: error.message });
    } finally {
        client.release();
    }
};

const main = async () => {
    await initDB();
    await producer.connect();
    console.log('✅ Connected to Kafka Producer');
    
    const server = new grpc.Server();
    server.addService(orderProto.OrderService.service, { CreateOrder });
    
    const port = process.env.GRPC_PORT || 50054;
    server.bindAsync(`0.0.0.0:${port}`, grpc.ServerCredentials.createInsecure(), () => {
        server.start();
        console.log(`🛒 Order gRPC Service is running on port ${port}`);
    });
};

main();