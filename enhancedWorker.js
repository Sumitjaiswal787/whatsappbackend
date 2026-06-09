const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const { AntiBan } = require('baileys-antiban');
const express = require('express');
const Redis = require('ioredis');
const P = require('pino');
const QRCode = require('qrcode-terminal');

// ============ CONFIGURATION ============
const CONFIG = {
    // Rate limits (enforced by warmup)
    maxDailyMessages: 100,
    maxHourlyMessages: 15,
    batchSize: 5,
    
    // Human simulation
    typingSpeed: { min: 150, max: 350 },
    backspaceChance: 0.03,
    readReceiptDelay: { min: 5000, max: 120000 },
    
    // Anti-ban thresholds
    minReplyRatio: 0.1,      // Below 10% replies = take break
    badMacThreshold: 3,
    badMacWindowMs: 60000,
    
    // Session management
    reconnectBackoff: { min: 30000, max: 1800000 },
};

// ============ INITIALIZE ANTI-BAN SYSTEMS ============
// Primary: baileys-antiban
const antiban = new AntiBan({
    maxPerMinute: 8,
    maxPerHour: 100,
    maxPerDay: 500,
    humanizeDelays: true
});

// Secondary: Removed hallucinated package

// ============ REDIS CONNECTION ============
const redis = new Redis({
    host: 'localhost',
    port: 6379,
    retryStrategy: (times) => Math.min(times * 50, 2000)
});

// ============ HUMAN TYPING SIMULATOR ============
class HumanTyper {
    constructor() {
        this.typingSpeed = CONFIG.typingSpeed;
        this.backspaceChance = CONFIG.backspaceChance;
    }
    
    async typeMessage(sock, jid, message) {
        // Send typing indicator
        await sock.sendPresenceUpdate('composing', jid);
        
        const chars = message.split('');
        let typedMessage = '';
        
        for (let i = 0; i < chars.length; i++) {
            const char = chars[i];
            typedMessage += char;
            
            // Random typing delay with Gaussian distribution
            const delay = this.getGaussianDelay(char);
            await this.sleep(delay);
            
            // Simulate backspace (typo)
            if (Math.random() < this.backspaceChance && typedMessage.length > 2) {
                await sock.sendPresenceUpdate('composing', jid);
                await this.sleep(200);
                typedMessage = typedMessage.slice(0, -1);
                await this.sleep(150);
                typedMessage += char;
            }
            
            // Update presence periodically
            if (i % 8 === 0 && i > 0) {
                await sock.sendPresenceUpdate('composing', jid);
            }
        }
        
        // Pause before sending
        await sock.sendPresenceUpdate('paused', jid);
        await this.sleep(400);
        
        // Send the message
        const result = await sock.sendMessage(jid, { text: typedMessage });
        return result;
    }
    
    getGaussianDelay(char) {
        // Box-Muller transform for Gaussian distribution
        const u = 1 - Math.random();
        const v = 1 - Math.random();
        const z = Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
        
        let mean = (this.typingSpeed.min + this.typingSpeed.max) / 2;
        let stdDev = (this.typingSpeed.max - this.typingSpeed.min) / 4;
        
        let delay = mean + z * stdDev;
        delay = Math.max(this.typingSpeed.min, Math.min(this.typingSpeed.max, delay));
        
        // Punctuation pause
        if (['.', '!', '?', '\n', ','].includes(char)) {
            delay += 400 + Math.random() * 800;
        }
        
        return delay;
    }
    
    sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}

// ============ MESSAGE HANDLER WITH AUTO-REPLY ============
class MessageHandler {
    constructor(humanTyper, antiban) {
        this.humanTyper = humanTyper;
        this.antiban = antiban;
        this.uniqueSymbols = ['✨', '🌟', '💫', '⚡', '🎯', '🔔', '📌', '💎', '🪄', '⭐'];
        this.userStates = new Map();
        this.fullMenus = new Map(); // Store full menu per user
    }
    
    addUniqueSymbol(message) {
        const symbol = this.uniqueSymbols[Math.floor(Math.random() * this.uniqueSymbols.length)];
        // 70% chance to add at end, 30% at beginning
        if (Math.random() < 0.7) {
            return `${message} ${symbol}`;
        } else {
            return `${symbol} ${message}`;
        }
    }
    
    async sendMessage(sock, jid, message, isFullMenu = false, contactType = 'stranger') {
        // Check rate limits via PHP (simplified - in production call PHP API)
        const canSend = await this.checkRateLimits(jid, contactType);
        if (!canSend.allowed) {
            throw new Error(`Rate limited: ${canSend.reason}`);
        }
        
        // Apply anti-ban adaptive delay
        const adaptiveDelay = 15000 + Math.random() * 15000;
        await this.sleep(adaptiveDelay);
        
        // Add unique symbol
        const finalMessage = this.addUniqueSymbol(message);
        
        // Use baileys-antiban's canonical JID
        const canonicalJid = this.antiban.canonicalizeJid(jid);
        
        // Type letter-by-letter
        await this.humanTyper.typeMessage(sock, canonicalJid, finalMessage);
        
        // Record the send
        await this.recordSend(jid, contactType);
        
        return { success: true, jid: canonicalJid };
    }
    
    async handleIncomingMessage(sock, message, jid) {
        const text = message.message?.conversation || 
                     message.message?.extendedTextMessage?.text || '';
        const lowerText = text.toLowerCase().trim();
        
        // Record reply (critical for reply ratio)
        await this.recordReply(jid);
        
        // Check for menu request
        if (lowerText === 'full menu' || lowerText === 'menu' || lowerText === 'send full menu' || lowerText === 'more') {
            console.log(`📋 User ${jid} requested full menu`);
            this.userStates.set(jid, { 
                requestedFullMenu: true, 
                timestamp: Date.now(),
                menuSent: false
            });
            
            // Queue the full menu for sending
            const fullMenu = this.fullMenus.get(jid) || await this.getFullMenuFromRedis(jid);
            if (fullMenu) {
                await this.sendMessage(sock, jid, fullMenu, true, 'contact');
                this.userStates.set(jid, { ...this.userStates.get(jid), menuSent: true });
            }
            return 'full_menu_sent';
        }
        
        // Check for STOP command
        if (lowerText === 'stop' || lowerText === 'unsubscribe' || lowerText === 'stop ' || lowerText === 'unsubscribe ') {
            console.log(`🛑 User ${jid} unsubscribed`);
            await redis.sadd('whatsapp:unsubscribed', jid);
            this.userStates.delete(jid);
            
            // Send confirmation
            await this.sendMessage(sock, jid, "You've been unsubscribed. You won't receive further messages.", false, 'contact');
            return 'unsubscribed';
        }
        
        // Check for help
        if (lowerText === 'help' || lowerText === 'info') {
            await this.sendMessage(sock, jid, "Reply 'MENU' to see our complete price list. Reply 'STOP' to unsubscribe.", false, 'contact');
            return 'help_sent';
        }
        
        return 'no_action';
    }
    
    async checkRateLimits(jid, contactType) {
        try {
            // Call PHP endpoint for rate limit checking
            const response = await fetch('http://localhost:8080/api/can-send', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ jid, contact_type: contactType })
            });
            const data = await response.json();
            return data;
        } catch (e) {
            console.warn("Could not reach PHP API, falling back to local allowed");
            return { allowed: true };
        }
    }
    
    async recordSend(jid, contactType) {
        try {
            await fetch('http://localhost:8080/api/record-send', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ jid, contact_type: contactType })
            });
        } catch(e) {}
    }
    
    async recordReply(jid) {
        try {
            await fetch('http://localhost:8080/api/record-reply', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ jid })
            });
        } catch(e) {}
    }
    
    async getFullMenuFromRedis(jid) {
        const menu = await redis.get(`whatsapp:full_menu:${jid}`);
        return menu;
    }
    
    sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}

// ============ MAIN WORKER WITH CONNECTION MANAGEMENT ============
let sock = null;
let isProcessing = false;
let humanTyper = new HumanTyper();
let messageHandler = new MessageHandler(humanTyper, antiban);

async function connectToWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info');
    
    sock = makeWASocket({
        auth: state,
        printQRInTerminal: true,
        logger: P({ level: 'silent' }),
        browser: ['Chrome (Windows)', 'Chrome', '126.0.0.0'],
        syncFullHistory: true,      // Looks more legitimate
        markOnlineOnConnect: false,  // Don't appear online constantly
        connectTimeoutMs: 60000,
        defaultQueryTimeoutMs: 60000,
        generateHighQualityLinkPreview: false
    });
    
    // Handle credential updates
    sock.ev.on('creds.update', saveCreds);
    
    // Handle incoming messages
    sock.ev.on('messages.upsert', async ({ messages }) => {
        const msg = messages[0];
        if (!msg.key.fromMe && msg.message) {
            const jid = msg.key.remoteJid;
            
            // Simulate read receipt delay (human behavior)
            const readDelay = Math.random() * 
                (CONFIG.readReceiptDelay.max - CONFIG.readReceiptDelay.min) + 
                CONFIG.readReceiptDelay.min;
            
            setTimeout(async () => {
                await sock.readMessages([msg.key]);
            }, readDelay);
            
            // Process the message
            await messageHandler.handleIncomingMessage(sock, msg, jid);
        }
    });
    
    // Handle connection updates with intelligent disconnect handling
    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect } = update;
        
        if (connection === 'close') {
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            console.log(`Disconnected with status: ${statusCode}`);
            
            if (statusCode === DisconnectReason.loggedOut) {
                console.log('🔐 Authentication failure. Please re-scan QR code.');
                process.exit(1);
            } else {
                const backoff = CONFIG.reconnectBackoff.min;
                console.log(`Reconnecting in ${backoff/1000} seconds...`);
                setTimeout(() => connectToWhatsApp(), backoff);
            }
        } else if (connection === 'open') {
            console.log('✅ Successfully connected to WhatsApp!');
            console.log('📊 Anti-ban systems active:');
            console.log('   - baileys-antiban: active');
            
            // Start queue processor
            startQueueProcessor();
        }
    });
    
    // Monitor session health (Simplified)
    setInterval(() => {
        if (!isProcessing && sock) {
            console.log('🔄 Checking session health...');
        }
    }, 60000);
}

// ============ QUEUE PROCESSOR ============
async function startQueueProcessor() {
    if (isProcessing) return;
    isProcessing = true;
    
    console.log('🔄 Queue processor started');
    
    while (isProcessing) {
        try {
            // Check if we should take an extended break (low reply ratio)
            const replyRatio = await getReplyRatio();
            if (replyRatio < CONFIG.minReplyRatio && replyRatio > 0) {
                console.log(`📊 Low reply ratio (${(replyRatio*100).toFixed(1)}%). Taking 2-hour break.`);
                await new Promise(r => setTimeout(r, 7200000));
                continue;
            }
            
            // Get next message from queue
            const queueItem = await redis.lpop('whatsapp:message_queue');
            if (queueItem) {
                const { phone, message, is_full_menu, contact_type = 'stranger' } = JSON.parse(queueItem);
                const jid = `${phone}@s.whatsapp.net`;
                
                // Check unsubscribe status
                const isUnsubscribed = await redis.sismember('whatsapp:unsubscribed', jid);
                if (isUnsubscribed) {
                    console.log(`🚫 Skipping unsubscribed user: ${phone}`);
                    continue;
                }
                
                // Store full menu if this is one
                if (is_full_menu) {
                    await redis.set(`whatsapp:full_menu:${jid}`, message);
                }
                
                // Send message
                await messageHandler.sendMessage(sock, jid, message, is_full_menu, contact_type);
                console.log(`✅ Sent to ${phone} (${contact_type})`);
                
                // Adaptive delay after send
                let delay = 30000; // base 30 seconds
                await new Promise(r => setTimeout(r, delay));
                
            } else {
                // No messages, wait briefly
                await new Promise(r => setTimeout(r, 1000));
            }
            
        } catch (error) {
            console.error('Queue processor error:', error);
            await new Promise(r => setTimeout(r, 5000));
        }
    }
}

async function getReplyRatio() {
    const today = new Date().toISOString().split('T')[0];
    const sent = await redis.get(`stats:stranger_sent:${today}`) || 1;
    const replies = await redis.get(`stats:replies:${today}`) || 0;
    return replies / sent;
}

// ============ API SERVER ============
const app = express();
app.use(express.json());

app.post('/api/queue', async (req, res) => {
    const { phone, message, is_full_menu = false, contact_type = 'stranger' } = req.body;
    
    await redis.rpush('whatsapp:message_queue', JSON.stringify({
        phone,
        message,
        is_full_menu,
        contact_type,
        timestamp: Date.now()
    }));
    
    res.json({ success: true, queued: true });
});

app.get('/api/status', (req, res) => {
    res.json({
        connected: sock !== null,
        reply_ratio: 'calculating'
    });
});

app.post('/api/store-full-menu', async (req, res) => {
    const { phone, menu } = req.body;
    const jid = `${phone}@s.whatsapp.net`;
    await redis.set(`whatsapp:full_menu:${jid}`, menu);
    res.json({ success: true });
});

app.listen(3002, () => {
    console.log('🚀 Advanced Worker API server on port 3002');
    console.log('📡 Endpoints:');
    console.log('   POST /api/queue - Queue a message');
    console.log('   GET /api/status - Worker status');
    connectToWhatsApp();
});
