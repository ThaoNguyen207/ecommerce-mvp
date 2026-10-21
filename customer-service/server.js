require('dotenv').config();
const grpc = require('@grpc/grpc-js');
const protoLoader = require('@grpc/proto-loader');
const { Pool } = require('pg');
const path = require('path');

// 1. Kết nối PostgreSQL
const pool = new Pool({
    connectionString: process.env.DATABASE_URL
});

// Khởi tạo Database Schema cho Customer Service
const initDB = async () => {
    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS membership (
                mid SERIAL PRIMARY KEY,
                mname VARCHAR(50) UNIQUE NOT NULL,
                score INT NOT NULL DEFAULT 0
            );

            CREATE TABLE IF NOT EXISTS customer (
                uid INT PRIMARY KEY,
                fullname VARCHAR(100) NOT NULL,
                mid INT REFERENCES membership(mid),
                score INT NOT NULL DEFAULT 0
            );

            ALTER TABLE customer ADD COLUMN IF NOT EXISTS score INT DEFAULT 0;

            INSERT INTO membership (mid, mname, score) VALUES 
                (1, 'BRONZE', 0),
                (2, 'SILVER', 50),
                (3, 'GOLD', 100)
            ON CONFLICT (mid) DO NOTHING;
        `);
        console.log('✅ Customer Database tables initialized successfully.');
    } catch (err) {
        console.error('❌ Database initialization error in customer-service:', err);
    }
};

// 2. Load gRPC Proto
const PROTO_PATH = path.join(__dirname, '../shared/proto/customer.proto');
const packageDefinition = protoLoader.loadSync(PROTO_PATH, {
    keepCase: true,
    longs: String,
    enums: String,
    defaults: true,
    oneofs: true
});
const customerProto = grpc.loadPackageDefinition(packageDefinition).customer;

// 3. Implement gRPC Methods
const CreateCustomerProfile = async (call, callback) => {
    const { uid, fullname } = call.request;
    try {
        if (!uid || !fullname) {
            return callback(null, { success: false, message: "uid and fullname are required" });
        }

        // Mặc định khách hàng mới có hạng BRONZE (mid = 1) và điểm score = 0
        await pool.query(
            `INSERT INTO customer (uid, fullname, mid, score)
             VALUES ($1, $2, 1, 0)
             ON CONFLICT (uid) DO UPDATE SET fullname = EXCLUDED.fullname`,
            [uid, fullname]
        );

        console.log(`👤 Customer profile created/updated for uid: ${uid}`);
        callback(null, { success: true, message: "Customer profile created successfully" });
    } catch (error) {
        console.error('❌ CreateCustomerProfile error:', error);
        callback(null, { success: false, message: error.message });
    }
};

const GetCustomerInfo = async (call, callback) => {
    const { uid } = call.request;
    try {
        const result = await pool.query(
            `SELECT c.uid, c.fullname, c.mid, COALESCE(c.score, m.score, 0) as score, m.mname as membership_name
             FROM customer c
             LEFT JOIN membership m ON c.mid = m.mid
             WHERE c.uid = $1`,
            [uid]
        );

        if (result.rows.length === 0) {
            return callback(null, {
                success: false,
                message: `Customer profile not found for uid: ${uid}`
            });
        }

        const customer = result.rows[0];
        callback(null, {
            success: true,
            uid: customer.uid,
            fullname: customer.fullname,
            mid: customer.mid,
            score: parseInt(customer.score, 10),
            message: "Customer info fetched successfully"
        });
    } catch (error) {
        console.error('❌ GetCustomerInfo error:', error);
        callback(null, { success: false, message: error.message });
    }
};

const UpdateCustomerScore = async (call, callback) => {
    const { uid, score } = call.request;
    try {
        // Tự động phân hạng membership dựa trên điểm score tích lũy
        // Score >= 100 -> GOLD (3)
        // Score >= 50 -> SILVER (2)
        // Dưới 50 -> BRONZE (1)
        let mid = 1;
        if (score >= 100) mid = 3;
        else if (score >= 50) mid = 2;

        const result = await pool.query(
            `UPDATE customer SET score = $1, mid = $2 WHERE uid = $3 RETURNING *`,
            [score, mid, uid]
        );

        if (result.rows.length === 0) {
            return callback(null, { success: false, message: `Customer not found for uid: ${uid}` });
        }

        console.log(`⭐ Updated score for customer uid ${uid}: ${score} (mid: ${mid})`);
        callback(null, {
            success: true,
            message: `Score updated to ${score} and tier updated to mid ${mid}`
        });
    } catch (error) {
        console.error('❌ UpdateCustomerScore error:', error);
        callback(null, { success: false, message: error.message });
    }
};

// 4. Khởi chạy gRPC Server
const main = async () => {
    await initDB();
    const server = new grpc.Server();
    server.addService(customerProto.CustomerService.service, {
        CreateCustomerProfile,
        GetCustomerInfo,
        UpdateCustomerScore
    });

    const port = process.env.GRPC_PORT || 50052;
    server.bindAsync(`0.0.0.0:${port}`, grpc.ServerCredentials.createInsecure(), (err, boundPort) => {
        if (err) {
            console.error('❌ Failed to bind customer service port:', err);
            return;
        }
        server.start();
        console.log(`👤 Customer gRPC Service is running on port ${boundPort}`);
    });
};

main();