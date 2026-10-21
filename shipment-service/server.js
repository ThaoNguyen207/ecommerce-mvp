require('dotenv').config();
const crypto = require('crypto');
global.crypto = crypto;
const mongoose = require('mongoose');
const { Kafka } = require('kafkajs');
const grpc = require('@grpc/grpc-js');
const protoLoader = require('@grpc/proto-loader');
const path = require('path');

// 1. Kết nối MongoDB
const mongoUrl = process.env.MONGO_URL || 'mongodb://mongodb:27017/shipment_db';
mongoose.connect(mongoUrl)
    .then(() => console.log('✅ Connected to MongoDB (Shipment DB) successfully!'))
    .catch(err => console.error('❌ MongoDB connection error in shipment-service:', err));

// Định nghĩa Schema cho Shipment theo ERD
const shipmentSchema = new mongoose.Schema({
    shipid: { type: Number, required: true, unique: true },
    oid: { type: Number, required: true },
    status: { type: String, default: 'PENDING' },
    updatedAt: { type: Date, default: Date.now }
});
const Shipment = mongoose.model('Shipment', shipmentSchema);

// 2. Load gRPC Proto
const PROTO_PATH = path.join(__dirname, '../shared/proto/shipment.proto');
const packageDefinition = protoLoader.loadSync(PROTO_PATH, {
    keepCase: true,
    longs: String,
    enums: String,
    defaults: true,
    oneofs: true
});
const shipmentProto = grpc.loadPackageDefinition(packageDefinition).shipment;

// 3. Implement gRPC Methods
const UpdateShipmentStatus = async (call, callback) => {
    const { shipid, status } = call.request;
    try {
        if (!shipid || !status) {
            return callback(null, { success: false, message: "shipid and status are required" });
        }

        const shipment = await Shipment.findOneAndUpdate(
            { shipid },
            { status: status.toUpperCase(), updatedAt: new Date() },
            { new: true }
        );

        if (!shipment) {
            return callback(null, {
                success: false,
                message: `Shipment with shipid ${shipid} not found`
            });
        }

        console.log(`🚚 Shipment [${shipid}] status updated to: ${status.toUpperCase()}`);
        callback(null, {
            success: true,
            message: `Shipment status updated to ${status.toUpperCase()}`
        });
    } catch (error) {
        console.error('❌ UpdateShipmentStatus error:', error);
        callback(null, { success: false, message: error.message });
    }
};

const GetShipmentByOrderId = async (call, callback) => {
    const { oid } = call.request;
    try {
        const shipment = await Shipment.findOne({ oid }).sort({ updatedAt: -1 });
        if (!shipment) {
            return callback(null, {
                success: false,
                message: `No shipment found for order oid ${oid}`
            });
        }

        callback(null, {
            success: true,
            shipid: shipment.shipid,
            oid: shipment.oid,
            status: shipment.status,
            message: "Shipment found"
        });
    } catch (error) {
        console.error('❌ GetShipmentByOrderId error:', error);
        callback(null, { success: false, message: error.message });
    }
};

const GetShipmentById = async (call, callback) => {
    const { shipid } = call.request;
    try {
        const shipment = await Shipment.findOne({ shipid });
        if (!shipment) {
            return callback(null, {
                success: false,
                message: `Shipment ${shipid} not found`
            });
        }

        callback(null, {
            success: true,
            shipid: shipment.shipid,
            oid: shipment.oid,
            status: shipment.status,
            message: "Shipment found"
        });
    } catch (error) {
        console.error('❌ GetShipmentById error:', error);
        callback(null, { success: false, message: error.message });
    }
};

// 4. Cấu hình & Khởi chạy Kafka Consumer
const kafkaBroker = process.env.KAFKA_BROKER || 'kafka:9092';
const kafka = new Kafka({
    clientId: 'shipment-service',
    brokers: [kafkaBroker]
});
const consumer = kafka.consumer({ groupId: 'shipment-group' });

const startKafkaConsumer = async () => {
    try {
        await consumer.connect();
        console.log('✅ Connected to Kafka Consumer');
        await consumer.subscribe({ topic: 'order-created', fromBeginning: true });

        await consumer.run({
            eachMessage: async ({ topic, partition, message }) => {
                try {
                    const eventData = JSON.parse(message.value.toString());
                    console.log(`\n📥 Received OrderCreated event for Order ID: ${eventData.oid}`);

                    // Sinh mã shipid tự động dạng số nguyên
                    const shipId = Math.floor(Date.now() / 1000);

                    const newShipment = new Shipment({
                        shipid: shipId,
                        oid: eventData.oid,
                        status: 'PENDING'
                    });

                    await newShipment.save();
                    console.log(`🚚 Shipment [${shipId}] created with status PENDING for Order ID: ${eventData.oid}`);
                } catch (error) {
                    console.error('❌ Error processing Kafka message in shipment-service:', error);
                }
            }
        });
    } catch (err) {
        console.error('❌ Failed to start Kafka consumer:', err.message);
    }
};

// 5. Khởi chạy gRPC Server
const startGrpcServer = () => {
    const server = new grpc.Server();
    server.addService(shipmentProto.ShipmentService.service, {
        UpdateShipmentStatus,
        GetShipmentByOrderId,
        GetShipmentById
    });

    const port = process.env.GRPC_PORT || 50055;
    server.bindAsync(`0.0.0.0:${port}`, grpc.ServerCredentials.createInsecure(), (err, boundPort) => {
        if (err) {
            console.error('❌ Failed to bind shipment service port:', err);
            return;
        }
        server.start();
        console.log(`🚚 Shipment gRPC Service is running on port ${boundPort}`);
    });
};

const main = async () => {
    startGrpcServer();
    await startKafkaConsumer();
};

main();