-- ═══════════════════════════════════════════════════════════════════════════
-- KYC SYSTEM  –  Schema Migrations
-- Run once against the kyc_system database.
-- ═══════════════════════════════════════════════════════════════════════════

USE kyc_system;

-- ─── FEATURE 1: AI Verification status column ────────────────────────────────
ALTER TABLE Clients
    ADD COLUMN verification_status ENUM('Pending', 'Verified', 'Failed')
        NOT NULL DEFAULT 'Pending'
    AFTER mapped_service_provider_id;

-- ─── FEATURE 2a: Encrypt existing client_name values ─────────────────────────
-- NOTE: After adding the column above, run this Node.js one-liner to re-encrypt
--       all existing plain-text names BEFORE enabling the encrypted code path:
--
--   node -e "
--     const {encrypt}=require('./crypto.utils');
--     const mysql=require('mysql2');
--     const db=mysql.createConnection({host:'127.0.0.1',port:3307,user:'root',password:'tito2212',database:'kyc_system'});
--     db.query('SELECT client_id, client_name FROM Clients', (e,rows)=>{
--       rows.forEach(r=>{
--         db.query('UPDATE Clients SET client_name=? WHERE client_id=?',[encrypt(r.client_name),r.client_id]);
--       });
--       setTimeout(()=>db.end(),2000);
--     });
--   "
--
-- ─── FEATURE 2b: Extend client_name column width for cipher-text ─────────────
-- Cipher-text for a 50-char name is ≈ 128 chars; 512 is safe.
ALTER TABLE Clients
    MODIFY COLUMN client_name VARCHAR(512) NOT NULL;

-- ─── FEATURE 2c: Audit / Assignment Log table ─────────────────────────────────
CREATE TABLE IF NOT EXISTS provider_assignment_logs (
    log_id          INT UNSIGNED    NOT NULL AUTO_INCREMENT,
    client_id       INT UNSIGNED    NOT NULL,
    old_provider_id INT UNSIGNED,                                  -- NULL if client was unassigned
    new_provider_id INT UNSIGNED    NOT NULL,
    changed_at      DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (log_id),
    INDEX idx_client    (client_id),
    INDEX idx_changed_at(changed_at),
    CONSTRAINT fk_log_client
        FOREIGN KEY (client_id)       REFERENCES Clients(client_id)          ON DELETE CASCADE,
    CONSTRAINT fk_log_old_provider
        FOREIGN KEY (old_provider_id) REFERENCES Service_Providers(service_provider_id) ON DELETE SET NULL,
    CONSTRAINT fk_log_new_provider
        FOREIGN KEY (new_provider_id) REFERENCES Service_Providers(service_provider_id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ─── FEATURE 3: Provider Load Analytics – verify LEFT JOIN query ──────────────
-- (This is the exact query used by GET /api/analytics/provider-load)
--
-- SELECT   sp.service_provider_id,
--          sp.service_provider_name,
--          COUNT(c.client_id) AS client_count
-- FROM     Service_Providers sp
-- LEFT JOIN Clients c ON c.mapped_service_provider_id = sp.service_provider_id
-- GROUP BY sp.service_provider_id, sp.service_provider_name
-- ORDER BY client_count DESC;
--
-- Providers with zero clients will appear with client_count = 0 because of
-- the LEFT JOIN – COUNT(c.client_id) counts only non-NULL client rows.
