-- PAN Hub Schema
-- The Hub stores the absolute minimum: public keys, routing metadata, encrypted blobs.
-- It CANNOT read message payloads — those are E2E encrypted between PAN instances.

-- Registered PAN instances
CREATE TABLE IF NOT EXISTS instances (
    id TEXT PRIMARY KEY,                          -- pan_xxxx (derived from public key hash)
    public_key TEXT NOT NULL,                     -- Ed25519 public key (base64)
    display_name_encrypted TEXT,                  -- encrypted by instance's own key, Hub can't read
    registered_at INTEGER NOT NULL,               -- ms since epoch
    last_seen INTEGER,                            -- ms since epoch
    banned INTEGER DEFAULT 0,
    ban_reason TEXT
);

-- Devices that connect through Hub to reach their PAN instance (phones, etc.)
CREATE TABLE IF NOT EXISTS devices (
    id TEXT PRIMARY KEY,                          -- dev_xxxx
    owner_instance_id TEXT NOT NULL REFERENCES instances(id),
    public_key TEXT NOT NULL,                     -- Ed25519 public key (base64)
    device_name_encrypted TEXT,                   -- encrypted, Hub can't read
    registered_at INTEGER NOT NULL,
    last_seen INTEGER
);

-- Federated orgs — the Hub tracks which instances belong to which orgs for routing
CREATE TABLE IF NOT EXISTS hub_orgs (
    org_id TEXT PRIMARY KEY,
    authority_instance_id TEXT NOT NULL REFERENCES instances(id),
    name_encrypted TEXT,                          -- encrypted, Hub can't read
    created_at INTEGER NOT NULL
);

-- Org membership for message fan-out
CREATE TABLE IF NOT EXISTS hub_org_members (
    org_id TEXT NOT NULL REFERENCES hub_orgs(org_id) ON DELETE CASCADE,
    instance_id TEXT NOT NULL REFERENCES instances(id),
    joined_at INTEGER NOT NULL,
    left_at INTEGER,
    PRIMARY KEY (org_id, instance_id)
);

-- Queued messages for offline delivery
CREATE TABLE IF NOT EXISTS message_queue (
    id TEXT PRIMARY KEY,                          -- msg_xxxx
    from_instance TEXT NOT NULL,
    to_instance TEXT NOT NULL,
    type TEXT NOT NULL,                           -- direct, org, discovery, federation
    payload_encrypted TEXT NOT NULL,              -- E2E encrypted, Hub can't read
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    delivered_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_queue_to ON message_queue(to_instance, delivered_at);
CREATE INDEX IF NOT EXISTS idx_queue_expires ON message_queue(expires_at);

-- Rate limiting
CREATE TABLE IF NOT EXISTS rate_limits (
    instance_id TEXT NOT NULL,
    window_start INTEGER NOT NULL,               -- minute-level window (ms)
    message_count INTEGER DEFAULT 0,
    PRIMARY KEY (instance_id, window_start)
);

-- Hub settings
CREATE TABLE IF NOT EXISTS hub_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at INTEGER NOT NULL
);
