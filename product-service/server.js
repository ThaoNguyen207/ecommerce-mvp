require('dotenv').config();
const grpc = require('@grpc/grpc-js');
const protoLoader = require('@grpc/proto-loader');
const mongoose = require('mongoose');
const path = require('path');
const crypto = require('crypto');
global.crypto = crypto;

// Kết nối MongoDB
mongoose.connect(process.env.MONGO_URL || 'mongodb://mongodb:27017/product_db')
    .then(() => console.log('✅ Connected to MongoDB (Product DB) successfully!'))
    .catch(err => console.error('❌ MongoDB connection error:', err));

// Định nghĩa Schema
const productSchema = new mongoose.Schema({
    pid: { type: Number, required: true, unique: true },
    pname: { type: String, required: true },
    price: { type: Number, required: true },
    quantity: { type: Number, required: true }
});
const Product = mongoose.model('Product', productSchema);

// Cấu hình gRPC
const PROTO_PATH = path.join(__dirname, '../shared/proto/product.proto');
const packageDefinition = protoLoader.loadSync(PROTO_PATH, {
    keepCase: true, longs: String, enums: String, defaults: true, oneofs: true
});
const productProto = grpc.loadPackageDefinition(packageDefinition).product;

// Hàm tạo sản phẩm
const CreateProduct = async (call, callback) => {
    try {
        const { pid, pname, price, quantity } = call.request;
        const newProduct = new Product({ pid, pname, price, quantity });
        await newProduct.save();
        callback(null, { success: true, message: "Product created successfully" });
    } catch (error) {
        callback(null, { success: false, message: error.message });
    }
};

// Hàm lấy thông tin sản phẩm theo ID
const GetProduct = async (call, callback) => {
    try {
        const product = await Product.findOne({ pid: call.request.pid });
        if (!product) return callback(null, { success: false, message: "Product not found" });
        callback(null, { success: true, pid: product.pid, pname: product.pname, price: product.price, quantity: product.quantity });
    } catch (error) {
        callback(null, { success: false, message: error.message });
    }
};

// Hàm lấy danh sách tất cả sản phẩm
const GetAllProducts = async (call, callback) => {
    try {
        const products = await Product.find().sort({ pid: 1 });
        const list = products.map(p => ({
            success: true,
            pid: p.pid,
            pname: p.pname,
            price: p.price,
            quantity: p.quantity,
            message: ""
        }));
        callback(null, { success: true, products: list, total: list.length });
    } catch (error) {
        callback(null, { success: false, products: [], total: 0 });
    }
};

// Hàm trừ tồn kho
const DecreaseQuantity = async (call, callback) => {
    try {
        const { pid, quantity_to_deduct } = call.request;
        const product = await Product.findOne({ pid });
        
        if (!product) return callback(null, { success: false, message: "Product not found" });
        if (product.quantity < quantity_to_deduct) {
            return callback(null, { success: false, message: "Not enough inventory" });
        }
        
        product.quantity -= quantity_to_deduct;
        await product.save();
        callback(null, { success: true, message: "Inventory deducted successfully" });
    } catch (error) {
        callback(null, { success: false, message: error.message });
    }
};

// Khởi chạy Server
const main = () => {
    const server = new grpc.Server();
    server.addService(productProto.ProductService.service, { CreateProduct, GetProduct, DecreaseQuantity, GetAllProducts });
    
    const port = process.env.GRPC_PORT || 50053;
    server.bindAsync(`0.0.0.0:${port}`, grpc.ServerCredentials.createInsecure(), () => {
        server.start();
        console.log(`📦 Product gRPC Service is running on port ${port}`);
    });
};

main();
