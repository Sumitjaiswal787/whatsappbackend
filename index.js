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
const cors = require('cors');

const app = express();
const port = process.env.PORT || 3001;
const SHARED_SECRET = process.env.SHARED_SECRET || "a_secure_shared_secret_here";
const PHP_CALLBACK_URL = process.env.PHP_CALLBACK_URL || "http://localhost:8000/api/callback.php";

app.use(cors());
app.use(bodyParser.json());

// Map to store active WhatsApp clients and their current state
const clients = new Map();
const sessionStates = new Map();

function getChromePath() {
    if (process.env.PUPPETEER_EXECUTABLE_PATH) return process.env.PUPPETEER_EXECUTABLE_PATH;
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

async function updatePHPStatus(sessionId, updateData) {
    // Keep internal state updated for REST API
    const currentState = sessionStates.get(sessionId) || {};
    sessionStates.set(sessionId, { ...currentState, ...updateData });

    try {
        if (PHP_CALLBACK_URL && PHP_CALLBACK_URL.startsWith('http')) {
            await axios.post(`${PHP_CALLBACK_URL}?secret=${SHARED_SECRET}`, {
                action: 'update_status',
                sessionId,
                ...updateData
            }).catch(() => {});
        }
    } catch (error) {
        // ignore webhook errors
    }
}

function initWhatsAppClient(sessionId, userId = 'default', phoneNumber = null) {
    if (clients.has(sessionId)) return clients.get(sessionId);

    console.log(`[${sessionId}] Initializing client...`);
    sessionStates.set(sessionId, { status: 'initializing' });
    
    const clientOptions = {
        authStrategy: new LocalAuth({ clientId: sessionId }),
        puppeteer: {
            headless: true,
            args: [
                '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
                '--disable-accelerated-2d-canvas', '--no-first-run', '--no-zygote',
                '--single-process', '--disable-gpu'
            ],
            executablePath: getChromePath()
        },
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
    };

    const client = new Client(clientOptions);

    client.on('qr', async (qr) => {
        console.log(`[${sessionId}] QR received`);
        qrcodeTerminal.generate(qr, { small: true });
        const qrBase64 = await qrcode.toDataURL(qr);
        updatePHPStatus(sessionId, { status: 'qr_ready', qr: qrBase64, qrRaw: qr });
    });

    client.on('ready', async () => {
        console.log(`[${sessionId}] Client is ready!`);
        updatePHPStatus(sessionId, { status: 'connected' });
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
        updatePHPStatus(sessionId, { status: 'error', error: err.message });
    });

    clients.set(sessionId, client);
    return client;
}

// REST API for CRM Integration (Multi-Tenant via sessionId)

app.get('/status', (req, res) => {
    const sessionId = req.query.sessionId;
    if (!sessionId) return res.status(400).json({ error: 'Missing sessionId' });
    
    if (!clients.has(sessionId)) {
        initWhatsAppClient(sessionId);
        return res.json({ status: 'initializing' });
    }
    
    const state = sessionStates.get(sessionId) || { status: 'unknown' };
    res.json({ status: state.status });
});

app.get('/qr', (req, res) => {
    const sessionId = req.query.sessionId;
    if (!sessionId) return res.status(400).send('Missing sessionId');
    
    const state = sessionStates.get(sessionId);
    if (!state || state.status !== 'qr_ready' || !state.qr) {
        return res.send('<h3>QR Code not ready or already connected. Please wait or check status.</h3><script>setTimeout(()=>location.reload(), 3000)</script>');
    }
    
    res.send(`
        <html>
        <body style="display:flex; justify-content:center; align-items:center; height:100vh; background:#f0f2f5; font-family:sans-serif;">
            <div style="text-align:center; background:#fff; padding:30px; border-radius:10px; box-shadow:0 4px 12px rgba(0,0,0,0.1);">
                <h2>Scan to Connect CRM</h2>
                <img src="${state.qr}" alt="QR Code" style="width:250px; height:250px;" />
                <p style="color:#666;">Waiting for scan...</p>
                <script>
                    setInterval(() => {
                        fetch('/status?sessionId=${sessionId}')
                            .then(r => r.json())
                            .then(d => { if(d.status === 'connected') document.body.innerHTML = '<h2>Successfully Connected!</h2>'; })
                    }, 3000);
                </script>
            </div>
        </body>
        </html>
    `);
});

app.post('/send', async (req, res) => {
    const { sessionId, number, message } = req.body;
    if (!sessionId || !number || !message) return res.status(400).json({ status: 'error', error: 'Missing params' });
    
    const client = clients.get(sessionId);
    if (!client) return res.status(400).json({ status: 'error', error: 'Session not connected' });
    
    try {
        const chatId = number.includes('@c.us') ? number : `${number}@c.us`;
        await client.sendMessage(chatId, message);
        res.json({ status: 'success' });
    } catch (e) {
        res.status(500).json({ status: 'error', error: e.message });
    }
});

app.post('/restart', async (req, res) => {
    const sessionId = req.body.sessionId || req.query.sessionId;
    if (!sessionId) return res.status(400).json({ error: 'Missing sessionId' });
    
    if (clients.has(sessionId)) {
        const client = clients.get(sessionId);
        try {
            await client.logout().catch(()=>{});
            await client.destroy().catch(()=>{});
        } catch (e) {}
        clients.delete(sessionId);
        sessionStates.delete(sessionId);
        
        const sessionPath = path.join(__dirname, '.wwebjs_auth', `session-${sessionId}`);
        if (fs.existsSync(sessionPath)) fs.rmSync(sessionPath, { recursive: true, force: true });
    }
    
    initWhatsAppClient(sessionId);
    res.json({ status: 'restarted' });
});

app.listen(port, () => {
    console.log(`Multi-Tenant WhatsApp Backend running at http://localhost:${port}`);
});
