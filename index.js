require('dotenv').config();
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, delay, Browsers, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
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
    sessionStates.set(sessionId, { status: 'initializing', reconnectAttempts: 0 });

    const authDir = path.join(__dirname, 'auth_info', `session-${sessionId}`);
    const { state, saveCreds } = await useMultiFileAuthState(authDir);

    const { version } = await fetchLatestBaileysVersion();
    const sock = makeWASocket({
        version,
        auth: state,
        printQRInTerminal: false,
        browser: ['Ubuntu', 'Chrome', '110.0.5481.192'],
        logger: pino({ level: 'silent' }), // suppress verbose logs
        connectTimeoutMs: 60000,
        qrTimeout: 40000,
        keepAliveIntervalMs: 15000,
        generateHighQualityLinkPreviews: true
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
            const statusCode = (lastDisconnect.error)?.output?.statusCode;
            const shouldReconnect = statusCode !== DisconnectReason.loggedOut && statusCode !== 428;
            console.log(`[${sessionId}] connection closed due to `, lastDisconnect.error, ', reconnecting ', shouldReconnect);
            
            if (shouldReconnect) {
                // If it's a 408 timeout (QR expired without scanning) or connection stuck
                if (statusCode === 408 || statusCode === 440) {
                    const currentState = sessionStates.get(sessionId) || {};
                    const attempts = (currentState.reconnectAttempts || 0) + 1;
                    console.warn(`[${sessionId}] Connection timeout (${statusCode}). Attempt ${attempts}`);
                    if (attempts >= 50) {
                        console.log(`[${sessionId}] High timeouts. Continuing to retry...`);
                    }
                    sessionStates.set(sessionId, { ...currentState, reconnectAttempts: attempts });
                }

                // Reconnect automatically
                sockets.delete(sessionId);
                const currentState = sessionStates.get(sessionId) || {};
                const attempts = currentState.reconnectAttempts || 0;
                const backoffDelay = Math.min(3000 * Math.pow(2, attempts), 60000); // Max 60 seconds
                console.log(`[${sessionId}] Reconnecting in ${backoffDelay}ms (Attempt ${attempts})...`);
                setTimeout(() => initWhatsAppClient(sessionId), backoffDelay);
            } else {
                // Logged out
                updatePHPStatus(sessionId, { status: 'disconnected', qr: null, qrRaw: null });
                sockets.delete(sessionId);
                if (fs.existsSync(authDir)) fs.rmSync(authDir, { recursive: true, force: true });
            }
        } else if (connection === 'open') {
            console.log(`[${sessionId}] Client is ready!`);
            const currentState = sessionStates.get(sessionId) || {};
            sessionStates.set(sessionId, { ...currentState, reconnectAttempts: 0 });
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
    res.json({ 
        status: state.status,
        qr: state.qr || null,
        qrRaw: state.qrRaw || null
    });
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
    const { sessionId, number, message, image } = req.body;
    if (!sessionId || !number || !message) return res.status(400).json({ status: 'error', error: 'Missing params' });
    
    const sock = sockets.get(sessionId);
    if (!sock || !sock.user) return res.status(400).json({ status: 'error', error: 'Session not authenticated or still connecting. Please scan the QR code.' });
    
    try {
        let formattedNumber = number.replace(/\D/g, '');
        if (formattedNumber.length === 10) {
            formattedNumber = '91' + formattedNumber;
        }
        const jid = formattedNumber.includes('@s.whatsapp.net') ? formattedNumber : `${formattedNumber}@s.whatsapp.net`;
        
        // Anti-ban: Simulate typing for a duration based on message length
        await sock.sendPresenceUpdate('composing', jid);
        const typingTime = 2000 + Math.random() * 2000 + (message.length * 20); // 2-4 seconds base + 20ms per char
        await delay(Math.min(typingTime, 8000)); // cap at 8 seconds max
        await sock.sendPresenceUpdate('paused', jid);

        if (image) {
            await sock.sendMessage(jid, { image: { url: image }, caption: message });
        } else {
            await sock.sendMessage(jid, { text: message });
        }
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

// Process-level crash guard
process.on('uncaughtException', (err) => {
    console.error('❌ uncaughtException (process protected):', err.message);
    try { console.error(err.stack); } catch (_) {}
});

process.on('unhandledRejection', (reason) => {
    console.error('❌ unhandledRejection (process protected):', reason);
});

