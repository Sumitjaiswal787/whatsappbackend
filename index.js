require('dotenv').config();
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, delay } = require('@whiskeysockets/baileys');
const pino = require('pino');
const qrcode = require('qrcode');
const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const path = require('path');
const fs = require('fs');
const cors = require('cors');

const app = express();
const port = process.env.PORT || 3001;
const SHARED_SECRET = process.env.SHARED_SECRET || "a_secure_shared_secret_here";
const PHP_CALLBACK_URL = process.env.PHP_CALLBACK_URL || "http://localhost:8000/api/callback.php";

app.use(cors());
app.use(bodyParser.json());

// Map to store active Baileys sockets and their current state
const sockets = new Map();
const sessionStates = new Map();

async function updatePHPStatus(sessionId, updateData) {
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
    } catch (error) {}
}

async function initWhatsAppClient(sessionId) {
    if (sockets.has(sessionId)) return sockets.get(sessionId);

    console.log(`[${sessionId}] Initializing Baileys client...`);
    sessionStates.set(sessionId, { status: 'initializing' });

    const authDir = path.join(__dirname, 'auth_info', `session-${sessionId}`);
    const { state, saveCreds } = await useMultiFileAuthState(authDir);

    const sock = makeWASocket({
        auth: state,
        printQRInTerminal: false,
        logger: pino({ level: 'silent' }) // suppress verbose logs
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            console.log(`[${sessionId}] QR received`);
            const qrBase64 = await qrcode.toDataURL(qr);
            updatePHPStatus(sessionId, { status: 'qr_ready', qr: qrBase64, qrRaw: qr });
        }

        if (connection === 'close') {
            const shouldReconnect = (lastDisconnect.error)?.output?.statusCode !== DisconnectReason.loggedOut;
            console.log(`[${sessionId}] connection closed due to `, lastDisconnect.error, ', reconnecting ', shouldReconnect);
            
            if (shouldReconnect) {
                // Reconnect automatically
                sockets.delete(sessionId);
                setTimeout(() => initWhatsAppClient(sessionId), 2000);
            } else {
                // Logged out
                updatePHPStatus(sessionId, { status: 'disconnected' });
                sockets.delete(sessionId);
                if (fs.existsSync(authDir)) fs.rmSync(authDir, { recursive: true, force: true });
            }
        } else if (connection === 'open') {
            console.log(`[${sessionId}] Client is ready!`);
            updatePHPStatus(sessionId, { status: 'connected' });
        }
    });

    sockets.set(sessionId, sock);
    return sock;
}

// REST API for CRM Integration (Multi-Tenant via sessionId)

app.get('/status', (req, res) => {
    const sessionId = req.query.sessionId;
    if (!sessionId) return res.status(400).json({ error: 'Missing sessionId' });
    
    if (!sockets.has(sessionId)) {
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
    
    const sock = sockets.get(sessionId);
    if (!sock) return res.status(400).json({ status: 'error', error: 'Session not connected' });
    
    try {
        const jid = number.includes('@s.whatsapp.net') ? number : `${number}@s.whatsapp.net`;
        await sock.sendMessage(jid, { text: message });
        res.json({ status: 'success' });
    } catch (e) {
        res.status(500).json({ status: 'error', error: e.message });
    }
});

app.post('/restart', async (req, res) => {
    const sessionId = req.body.sessionId || req.query.sessionId;
    if (!sessionId) return res.status(400).json({ error: 'Missing sessionId' });
    
    if (sockets.has(sessionId)) {
        const sock = sockets.get(sessionId);
        try {
            sock.logout();
        } catch (e) {}
        sockets.delete(sessionId);
        sessionStates.delete(sessionId);
        
        const authDir = path.join(__dirname, 'auth_info', `session-${sessionId}`);
        if (fs.existsSync(authDir)) fs.rmSync(authDir, { recursive: true, force: true });
    }
    
    initWhatsAppClient(sessionId);
    res.json({ status: 'restarted' });
});

app.listen(port, () => {
    console.log(`Baileys Multi-Tenant WhatsApp Backend running at http://localhost:${port}`);
});
