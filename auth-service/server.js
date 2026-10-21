require('dotenv').config();
const grpc = require('@grpc/grpc-js');
const protoLoader = require('@grpc/proto-loader');
const { Pool } = require('pg');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const path = require('path');

// 1. Kết nối PostgreSQL
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// Khởi tạo Database Schema dựa trên Bounded Context
const initDB = async () => {
    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS role (
                roleid SERIAL PRIMARY KEY,
                rolename VARCHAR(50) UNIQUE NOT NULL
            );
            CREATE TABLE IF NOT EXISTS "user" (
                uid SERIAL PRIMARY KEY,
                username VARCHAR(50) UNIQUE NOT NULL,
                password VARCHAR(255) NOT NULL,
                roleid INT REFERENCES role(roleid)
            );
            INSERT INTO role (rolename) VALUES ('ADMIN'), ('USER') ON CONFLICT DO NOTHING;
        `);
        console.log('✅ Auth Database tables initialized successfully.');
    } catch (err) {
        console.error('❌ Database initialization error:', err);
    }
};

// 2. Load gRPC Proto
const PROTO_PATH = path.join(__dirname, '../shared/proto/auth.proto');
const packageDefinition = protoLoader.loadSync(PROTO_PATH, {
    keepCase: true, longs: String, enums: String, defaults: true, oneofs: true
});
const authProto = grpc.loadPackageDefinition(packageDefinition).auth;

// 3. Implement gRPC Methods
const Register = async (call, callback) => {
    const { username, password } = call.request;
    try {
        const hashedPassword = await bcrypt.hash(password, 10);
        // Lấy mặc định role là USER (giả sử roleid = 2)
        const roleRes = await pool.query("SELECT roleid FROM role WHERE rolename = 'USER'");
        const roleId = roleRes.rows[0].roleid;

        const result = await pool.query(
            'INSERT INTO "user" (username, password, roleid) VALUES ($1, $2, $3) RETURNING uid',
            [username, hashedPassword, roleId]
        );
        callback(null, { success: true, message: "User registered successfully", uid: result.rows[0].uid });
    } catch (error) {
        callback(null, { success: false, message: "Registration failed: " + error.message });
    }
};

const Login = async (call, callback) => {
    const { username, password } = call.request;
    try {
        const result = await pool.query('SELECT * FROM "user" WHERE username = $1', [username]);
        if (result.rows.length === 0) {
            return callback(null, { success: false, message: "Invalid credentials" });
        }
        const user = result.rows[0];
        const isMatch = await bcrypt.compare(password, user.password);
        
        if (isMatch) {
            const token = jwt.sign({ uid: user.uid, roleid: user.roleid }, process.env.JWT_SECRET, { expiresIn: '24h' });
            callback(null, { success: true, message: "Login successful", uid: user.uid, token });
        } else {
            callback(null, { success: false, message: "Invalid credentials" });
        }
    } catch (error) {
        callback(null, { success: false, message: "Login error" });
    }
};

const ValidateToken = (call, callback) => {
    const { token } = call.request;
    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        callback(null, { valid: true, uid: decoded.uid, roleid: decoded.roleid });
    } catch (error) {
        callback(null, { valid: false });
    }
};

// 4. Khởi chạy gRPC Server
const main = async () => {
    await initDB();
    const server = new grpc.Server();
    server.addService(authProto.AuthService.service, { Register, Login, ValidateToken });
    
    const port = process.env.GRPC_PORT || 50051;
    server.bindAsync(`0.0.0.0:${port}`, grpc.ServerCredentials.createInsecure(), () => {
        server.start();
        console.log(`🛡️  Auth gRPC Service is running on port ${port}`);
    });
};

main();