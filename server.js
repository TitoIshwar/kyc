require('dotenv').config();
const express  = require('express');
const mysql    = require('mysql2');
const cors     = require('cors');
const multer   = require('multer');
const Tesseract = require('tesseract.js');
const axios    = require('axios');
// Encryption removed — client_name stored as plain text

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(__dirname)); // serves index.html at localhost:3000

// ─── Multer – keep uploaded ID images in memory ──────────────────────────────
const upload = multer({ storage: multer.memoryStorage() });

// ─── DATABASE CONNECTION (retry loop) ────────────────────────────────────────
let db;

function connectToMySQL() {
    db = mysql.createConnection({
        host:     process.env.DB_HOST     || '127.0.0.1',
        port:     process.env.DB_PORT     || 3307,
        user:     process.env.DB_USER     || 'root',
        password: process.env.DB_PASSWORD || 'tito2212',
        database: process.env.DB_NAME     || 'kyc_system',
        ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : undefined
    });

    db.connect(err => {
        if (err) {
            console.log('⏳ MySQL not ready, retrying in 5 seconds...');
            setTimeout(connectToMySQL, 5000);
        } else {
            console.log('✅ Connected to MySQL Database.');
        }
    });
}

connectToMySQL();

// ─── Helper: promisify db.query ───────────────────────────────────────────────
function dbQuery(sql, params = []) {
    return new Promise((resolve, reject) => {
        db.query(sql, params, (err, result) => (err ? reject(err) : resolve(result)));
    });
}

// ─── Helper: promisify db.beginTransaction / commit / rollback ────────────────
function beginTransaction() { return new Promise((res, rej) => db.beginTransaction(e => e ? rej(e) : res())); }
function commit()           { return new Promise((res, rej) => db.commit(e => e ? rej(e) : res())); }
function rollback()         { return new Promise((res, rej) => db.rollback(() => res())); }

// ═══════════════════════════════════════════════════════════════════════════════
// 1. Get Client Info  (decrypt client_name on retrieval)
// ═══════════════════════════════════════════════════════════════════════════════
app.get('/api/client/:name', async (req, res) => {
    try {
        const name = req.params.name;
        const results = await dbQuery(`
            SELECT c.client_id, c.client_name, c.mapped_service_provider_id,
                   c.verification_status, s.service_provider_name
            FROM   Clients c
            LEFT JOIN Service_Providers s ON c.mapped_service_provider_id = s.service_provider_id
            WHERE  c.client_name = ?
        `, [name]);

        if (results.length === 0) return res.status(404).json({ message: 'Client not found' });
        res.json(results[0]);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ═══════════════════════════════════════════════════════════════════════════════
// 2. Get all providers
// ═══════════════════════════════════════════════════════════════════════════════
app.get('/api/providers', async (req, res) => {
    try {
        const results = await dbQuery('SELECT * FROM Service_Providers');
        res.json(results);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ═══════════════════════════════════════════════════════════════════════════════
// 3. Update provider mapping  — with TRANSACTION + AUDIT LOG
// ═══════════════════════════════════════════════════════════════════════════════
app.post('/api/update', async (req, res) => {
    const { client_id, new_provider_id } = req.body;

    try {
        const rows = await dbQuery(
            'SELECT mapped_service_provider_id FROM Clients WHERE client_id = ?',
            [client_id]
        );

        if (rows.length === 0) return res.status(404).json({ message: 'Client not found' });

        const old_provider_id = rows[0].mapped_service_provider_id;

        if (old_provider_id === new_provider_id) {
            return res.status(400).json({ message: 'New provider cannot be the same as the current provider' });
        }

        await beginTransaction();
        try {
            await dbQuery(
                'UPDATE Clients SET mapped_service_provider_id = ? WHERE client_id = ?',
                [new_provider_id, client_id]
            );
            await dbQuery(
                `INSERT INTO provider_assignment_logs (client_id, old_provider_id, new_provider_id)
                 VALUES (?, ?, ?)`,
                [client_id, old_provider_id, new_provider_id]
            );
            await commit();
            res.json({ message: 'Update successful! Audit log recorded.' });
        } catch (innerErr) {
            await rollback();
            throw innerErr;
        }
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ═══════════════════════════════════════════════════════════════════════════════
// 4. FEATURE 1 — AI-Powered Document Verification  (OCR + Ollama LLaMA)
// ═══════════════════════════════════════════════════════════════════════════════
app.post('/api/verify-id', upload.single('id_image'), async (req, res) => {
    const { client_id } = req.body;

    if (!req.file)    return res.status(400).json({ error: 'No image uploaded.' });
    if (!client_id)   return res.status(400).json({ error: 'client_id is required.' });

    try {
        // ── Step A: OCR with Tesseract.js ────────────────────────────────────
        const { data: { text: rawText } } = await Tesseract.recognize(
            req.file.buffer,
            'eng',
            { logger: () => {} }          // suppress progress logs
        );
        console.log('[OCR] Raw text:', rawText.trim());

        // ── Step B: LLM Parsing via local Ollama ─────────────────────────────
        const prompt = `
You are a document parser. Given the raw OCR text from a government-issued ID below,
extract ONLY a valid JSON object with exactly two keys: "extracted_name" and "id_number".
Do NOT include any markdown, explanation, or extra text — only the JSON object.

OCR Text:
"""
${rawText.trim()}
"""
`.trim();

        const ollamaRes = await axios.post('http://localhost:11434/api/generate', {
            model: 'llama3',
            prompt,
            stream: false
        });

        let parsed;
        try {
            // Ollama wraps the response in ollamaRes.data.response
            const jsonString = ollamaRes.data.response.trim();
            // Robustly extract JSON even if wrapped in markdown code fences
            const jsonMatch = jsonString.match(/\{[\s\S]*\}/);
            parsed = JSON.parse(jsonMatch ? jsonMatch[0] : jsonString);
        } catch {
            return res.status(422).json({
                error: 'LLM returned non-JSON output.',
                raw: ollamaRes.data.response
            });
        }

        const { extracted_name, id_number } = parsed;
        console.log('[LLM] Parsed:', parsed);

        // ── Step C: Fetch + decrypt stored client_name ───────────────────────
        const rows = await dbQuery(
            'SELECT client_name FROM Clients WHERE client_id = ?',
            [client_id]
        );
        if (rows.length === 0) return res.status(404).json({ error: 'Client not found.' });

        const storedName = rows[0].client_name.toLowerCase().trim();
        const docName    = (extracted_name || '').toLowerCase().trim();
        const status     = storedName === docName ? 'Verified' : 'Failed';

        // ── Step D: Persist verification_status ──────────────────────────────
        await dbQuery(
            'UPDATE Clients SET verification_status = ? WHERE client_id = ?',
            [status, client_id]
        );

        res.json({
            status,
            extracted_name,
            id_number,
            stored_name: storedName,
            message: status === 'Verified'
                ? '✅ Identity verified successfully.'
                : '❌ Name mismatch — verification failed.'
        });

    } catch (err) {
        console.error('[verify-id error]', err.message);
        res.status(500).json({ error: err.message });
    }
});

// ═══════════════════════════════════════════════════════════════════════════════
// 5. Audit Log retrieval
// ═══════════════════════════════════════════════════════════════════════════════
app.get('/api/audit-logs', async (req, res) => {
    try {
        const rows = await dbQuery(
            `SELECT log_id, client_id, old_provider_id, new_provider_id, changed_at
             FROM   provider_assignment_logs
             ORDER  BY changed_at DESC
             LIMIT  200`
        );
        res.json(rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ═══════════════════════════════════════════════════════════════════════════════
// 6. FEATURE 3 — Provider Load Analytics  (LEFT JOIN, zero counts included)
// ═══════════════════════════════════════════════════════════════════════════════
app.get('/api/analytics/provider-load', async (req, res) => {
    try {
        const sql = `
            SELECT   sp.service_provider_id,
                     sp.service_provider_name,
                     COUNT(c.client_id) AS client_count
            FROM     Service_Providers sp
            LEFT JOIN Clients c ON c.mapped_service_provider_id = sp.service_provider_id
            GROUP BY sp.service_provider_id, sp.service_provider_name
            ORDER BY client_count DESC
        `;
        const rows = await dbQuery(sql);
        res.json(rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ─── Start server ─────────────────────────────────────────────────────────────
app.listen(3000, () => console.log('🚀 Server running on port 3000'));
