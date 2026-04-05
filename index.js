require('dotenv').config();
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode');
const qrcodeTerminal = require('qrcode-terminal');
const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const path = require('path');
const fs = require('fs');
const puppeteer = require('puppeteer');

const app = express();
const port = process.env.PORT || 3001;
const SHARED_SECRET = process.env.SHARED_SECRET || "a_secure_shared_secret_here";
const PHP_CALLBACK_URL = process.env.PHP_CALLBACK_URL || "http://localhost:8000/api/callback.php";

app.use(bodyParser.json());

/**
 * Mock WhatsApp Client for Bypassing Authentication
 */
class MockClient {
    constructor(sessionId, userId) {
        this.sessionId = sessionId;
        this.userId = userId;
        this.info = { wid: { user: '917324838976' }, pushname: 'Test Account (Bypassed)' };
        this.events = {};
    }

    on(event, callback) { this.events[event] = callback; }
    
    async initialize() {
        console.log(`[${this.sessionId}] Mock Client Initializing...`);
        // Simulate real-time connection events
        setTimeout(() => {
            if (this.events['ready']) this.events['ready']();
        }, 3000);
    }

    async getChats() { return []; }
    async destroy() { console.log(`[${this.sessionId}] Mock Client Destroyed.`); }
    async logout() { console.log(`[${this.sessionId}] Mock Client Logged Out.`); }
    async getContactById(id) { return { name: 'Test Contact' }; }
}

// Map to store active WhatsApp clients
const clients = new Map();

/**
 * Find Chrome Executable on Windows
 */
function getChromePath() {
    if (process.env.PUPPETEER_EXECUTABLE_PATH) {
        return process.env.PUPPETEER_EXECUTABLE_PATH;
    }

    const paths = [
        'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
        'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
        'C:\\Users\\' + process.env.USERNAME + '\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe'
    ];

    for (const p of paths) {
        if (fs.existsSync(p)) return p;
    }
    return puppeteer.executablePath();
}

/**
 * Helper: Send Status Update to PHP
 */
async function updatePHPStatus(sessionId, updateData) {
    try {
        await axios.post(`${PHP_CALLBACK_URL}?secret=${SHARED_SECRET}`, {
            action: 'update_status',
            sessionId,
            ...updateData
        });
    } catch (error) {
        console.error(`[${sessionId}] Failed to update PHP status:`, error.message);
    }
}

/**
 * Initialize a WhatsApp Client
 */
function initWhatsAppClient(sessionId, userId, phoneNumber = null) {
    if (clients.has(sessionId)) return clients.get(sessionId);

    // Bypassing / Mock Mode: phoneNumber === 'mock'
    if (phoneNumber === 'mock') {
        const client = new MockClient(sessionId, userId);
        client.on('ready', async () => {
            console.log(`[${sessionId}] Mock Client is ready!`);
            updatePHPStatus(sessionId, { 
                status: 'connected', 
                name: 'Test Account (Bypassed)', 
                number: '917324838976' 
            });
        });

        client.initialize();
        clients.set(sessionId, client);
        return client;
    }

    console.log(`[${sessionId}] Initializing client (Pairing: ${phoneNumber || 'QR'})...`);
    
    const clientOptions = {
        authStrategy: new LocalAuth({ clientId: sessionId }),
        puppeteer: {
            headless: true,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-accelerated-2d-canvas',
                '--no-first-run',
                '--no-zygote',
                '--single-process',
                '--disable-gpu'
            ],
            executablePath: getChromePath()
        },
        userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
        authTimeoutMs: 60000,
        qrMaxRetries: 10
    };

    if (phoneNumber) {
        clientOptions.pairWithPhoneNumber = {
            phoneNumber: phoneNumber,
            showNotification: true
        };
    }

    const client = new Client(clientOptions);

    /**
     * Sync Recently Received Messages
     */
    async function syncChatHistory(client, sessionId, userId) {
        console.log(`[${sessionId}] Syncing message history...`);
        try {
            const chats = await client.getChats();
            const syncData = [];
            
            for (const chat of chats) {
                // Ignore groups and archived? For now just non-groups
                if (chat.isGroup) continue;
                
                const contact = await chat.getContact();
                const phone = contact.number || chat.id.user;
                const name = contact.pushname || contact.name || chat.name || 'Unknown';

                const messages = await chat.fetchMessages({ limit: 50 });
                for (const msg of messages) {
                    syncData.push({
                        messageId: msg.id._serialized,
                        phone: phone,
                        originalId: chat.id.user,
                        name: name,
                        body: msg.body,
                        sender: msg.fromMe ? 'me' : 'lead',
                        timestamp: msg.timestamp
                    });
                }
            }
            
            if (syncData.length > 0) {
                await axios.post(`${PHP_CALLBACK_URL}?secret=${SHARED_SECRET}`, {
                    action: 'sync_messages',
                    sessionId,
                    userId,
                    messages: syncData
                });
                console.log(`[${sessionId}] Synced ${syncData.length} historical messages.`);
            }
        } catch (e) {
            console.error(`[${sessionId}] History sync failed:`, e.message);
        }
    }

    client.on('qr', async (qr) => {
        if (phoneNumber) return; // Ignore QR if pairing by phone
        console.log(`[${sessionId}] QR received:`);
        qrcodeTerminal.generate(qr, { small: true });
        const qrBase64 = await qrcode.toDataURL(qr);
        updatePHPStatus(sessionId, { status: 'qr_ready', qr: qrBase64 });
    });

    client.on('code', async (code) => {
        console.log(`[${sessionId}] Pairing Code: ${code}`);
        updatePHPStatus(sessionId, { status: 'pairing_ready', pairingCode: code });
    });

    client.on('ready', async () => {
        console.log(`[${sessionId}] Client is ready!`);
        try {
            const info = client.info;
            const number = info.wid.user || client.info.me.user;
            const name = info.pushname || (await client.getContactById(info.wid._serialized)).name || 'WhatsApp User';
            
            console.log(`[${sessionId}] Connected as: ${name} (${number})`);
            
            updatePHPStatus(sessionId, { 
                status: 'connected', 
                name: name, 
                number: number 
            });

            // Start History Sync
            syncChatHistory(client, sessionId, userId);
            
        } catch (e) {
            console.error(`[${sessionId}] Error getting client info:`, e.message);
            updatePHPStatus(sessionId, { status: 'connected' });
        }
    });

    client.on('message', async (msg) => {
        if (msg.from.includes('@g.us')) return;

        const phone = msg.from.split('@')[0];
        const message = msg.body;
        const messageId = msg.id._serialized;

        console.log(`[${sessionId}] New message from ${phone}: ${message}`);
        
        try {
            const contact = await msg.getContact();
            const resolvedPhone = contact.number || phone;

            await axios.post(`${PHP_CALLBACK_URL}?secret=${SHARED_SECRET}`, {
                action: 'log_message',
                sessionId,
                phone: resolvedPhone,
                message,
                messageId
            });

            await axios.post(`${PHP_CALLBACK_URL}?secret=${SHARED_SECRET}`, {
                action: 'new_lead',
                sessionId,
                userId,
                phone: resolvedPhone,
                originalId: phone,
                name: contact.pushname || contact.name || 'Unknown',
                message,
                messageId
            });
            
        } catch (error) {
            console.error(`[${sessionId}] Failed to process message:`, error.message);
        }
    });

    client.on('disconnected', (reason) => {
        console.log(`[${sessionId}] Client disconnected:`, reason);
        updatePHPStatus(sessionId, { status: 'disconnected' });
        clients.delete(sessionId);
    });

    client.on('auth_failure', (msg) => {
        console.error(`[${sessionId}] Authentication failure:`, msg);
        updatePHPStatus(sessionId, { status: 'disconnected' });
    });

    client.initialize().catch(err => {
        console.error(`[${sessionId}] FATAL Initialization failed:`, err);
        updatePHPStatus(sessionId, { status: 'disconnected' });
    });

    clients.set(sessionId, client);
    return client;
}

/**
 * API Endpoint: Initialize Session
 */
app.post('/session/init', (req, res) => {
    const { sessionId, userId, phoneNumber } = req.body;
    console.log(`[INIT] Session request received - ID: ${sessionId}, User: ${userId}, Phone: ${phoneNumber || 'None'}`);
    if (!sessionId || !userId) return res.status(400).json({ success: false, message: 'Missing params' });

    initWhatsAppClient(sessionId, userId, phoneNumber);
    res.json({ success: true, message: 'Initialization started' });
});

/**
 * API Endpoint: Delete Session
 */
app.post('/session/delete', async (req, res) => {
    const { sessionId } = req.body;
    if (clients.has(sessionId)) {
        const client = clients.get(sessionId);
        try {
            await client.logout();
            await client.destroy();
            clients.delete(sessionId);
            
            // Clean up session folder
            const sessionPath = path.join(__dirname, '.wwebjs_auth', `session-${sessionId}`);
            if (fs.existsSync(sessionPath)) {
                fs.rmSync(sessionPath, { recursive: true, force: true });
            }
        } catch (e) {
            console.error("Cleanup error", e);
        }
    }
    res.json({ success: true, message: 'Session deleted' });
});

app.listen(port, () => {
    console.log(`Worker service listening at http://localhost:${port}`);
});
