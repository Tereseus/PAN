CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    project_id INTEGER REFERENCES projects(id),
    cwd TEXT NOT NULL,
    model TEXT,
    source TEXT,
    transcript_path TEXT,
    started_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
    ended_at TEXT
);

CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL REFERENCES sessions(id),
    event_type TEXT NOT NULL,
    data TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE INDEX IF NOT EXISTS idx_events_session ON events(session_id);
CREATE INDEX IF NOT EXISTS idx_events_type ON events(event_type);
CREATE INDEX IF NOT EXISTS idx_events_created ON events(created_at);

CREATE TABLE IF NOT EXISTS projects (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    path TEXT NOT NULL,
    description TEXT,
    classification TEXT,
    team_id INTEGER,                  -- team that owns this project
    created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE INDEX IF NOT EXISTS idx_projects_path ON projects(path);

CREATE TABLE IF NOT EXISTS memory_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT REFERENCES sessions(id),
    event_id INTEGER REFERENCES events(id),
    item_type TEXT NOT NULL,
    content TEXT NOT NULL,
    context TEXT,
    confidence REAL DEFAULT 0.0,
    classified_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE INDEX IF NOT EXISTS idx_memory_type ON memory_items(item_type);
CREATE INDEX IF NOT EXISTS idx_memory_session ON memory_items(session_id);

CREATE TABLE IF NOT EXISTS devices (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    hostname TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    device_type TEXT DEFAULT 'pc',
    capabilities TEXT DEFAULT '[]',
    last_seen TEXT NOT NULL DEFAULT (datetime('now','localtime')),
    created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS command_queue (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    target_device TEXT NOT NULL,
    command_type TEXT NOT NULL,
    command TEXT,
    text TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    result TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
    completed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_commands_device ON command_queue(target_device, status);
CREATE INDEX IF NOT EXISTS idx_commands_created ON command_queue(created_at);

CREATE TABLE IF NOT EXISTS command_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    command_id INTEGER REFERENCES command_queue(id),
    step TEXT NOT NULL,
    detail TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE INDEX IF NOT EXISTS idx_cmdlogs_command ON command_logs(command_id);

-- Project milestone and task tracking — percentages, progress, what's done vs what's left
CREATE TABLE IF NOT EXISTS project_milestones (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER REFERENCES projects(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    description TEXT,
    sort_order INTEGER DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE INDEX IF NOT EXISTS idx_milestones_project ON project_milestones(project_id);

CREATE TABLE IF NOT EXISTS project_tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER REFERENCES projects(id) ON DELETE CASCADE,
    milestone_id INTEGER REFERENCES project_milestones(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    description TEXT,
    status TEXT NOT NULL DEFAULT 'todo',  -- todo, in_progress, done
    priority INTEGER DEFAULT 0,           -- 0=normal, 1=high, 2=critical
    sort_order INTEGER DEFAULT 0,
    assigned_to INTEGER,              -- user_id
    team_id INTEGER,                  -- team assignment
    created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
    completed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_tasks_project ON project_tasks(project_id);
CREATE INDEX IF NOT EXISTS idx_tasks_milestone ON project_tasks(milestone_id);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON project_tasks(status);

-- Terminal tabs — persistent, renamable, survive restarts
CREATE TABLE IF NOT EXISTS open_tabs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL UNIQUE,
    tab_name TEXT NOT NULL DEFAULT '',
    project_id INTEGER REFERENCES projects(id) ON DELETE SET NULL,
    cwd TEXT,
    tab_index INTEGER DEFAULT 0,
    claude_session_ids TEXT DEFAULT '[]',
    closed_at TEXT DEFAULT NULL,
    opened_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
    last_active TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE INDEX IF NOT EXISTS idx_open_tabs_project ON open_tabs(project_id);

-- Custom sections per project (Tasks and Bugs are built-in, users can add more)
CREATE TABLE IF NOT EXISTS project_sections (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER REFERENCES projects(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    sort_order INTEGER DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE INDEX IF NOT EXISTS idx_sections_project ON project_sections(project_id);

-- Section items (generic items in custom sections)
CREATE TABLE IF NOT EXISTS section_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    section_id INTEGER REFERENCES project_sections(id) ON DELETE CASCADE,
    project_id INTEGER REFERENCES projects(id) ON DELETE CASCADE,
    content TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'open',  -- open, done
    sort_order INTEGER DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE INDEX IF NOT EXISTS idx_section_items ON section_items(section_id);

-- Key-value settings store (AutoDev config, user preferences, etc.)
CREATE TABLE IF NOT EXISTS settings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    key TEXT NOT NULL UNIQUE,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

-- Sensor definitions — all 22 PAN sensors (seeded on startup, not user-editable)
CREATE TABLE IF NOT EXISTS sensor_definitions (
    id TEXT PRIMARY KEY,              -- e.g. 'camera', 'gps', 'gas'
    name TEXT NOT NULL,               -- Display name: 'Camera (OV2640)'
    category TEXT NOT NULL,           -- 'passive' or 'active'
    description TEXT,                 -- Short description
    icon TEXT,                        -- Emoji icon for dashboard
    sort_order INTEGER DEFAULT 0
);

-- Per-device sensor config — which sensors a device has + master mute
CREATE TABLE IF NOT EXISTS device_sensors (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    device_id INTEGER NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
    sensor_id TEXT NOT NULL REFERENCES sensor_definitions(id),
    available INTEGER NOT NULL DEFAULT 1,  -- does this device have this sensor?
    muted INTEGER NOT NULL DEFAULT 0,      -- master mute toggle
    policy TEXT,                           -- null=user control, 'force_on'=org requires it, 'force_off'=org disables it
    policy_reason TEXT,                    -- why the org forced this (e.g. "Emergency GPS required by safety policy")
    UNIQUE(device_id, sensor_id)
);

CREATE INDEX IF NOT EXISTS idx_device_sensors_device ON device_sensors(device_id);

-- Per-device, per-sensor category attachment toggles
-- e.g. "when taking a photo on the phone, also attach GPS data"
CREATE TABLE IF NOT EXISTS sensor_attachments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    device_id INTEGER NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
    sensor_id TEXT NOT NULL REFERENCES sensor_definitions(id),       -- the sensor providing data
    attach_to TEXT NOT NULL REFERENCES sensor_definitions(id),       -- the category it attaches to
    enabled INTEGER NOT NULL DEFAULT 0,
    UNIQUE(device_id, sensor_id, attach_to)
);

CREATE INDEX IF NOT EXISTS idx_sensor_attachments_device ON sensor_attachments(device_id);
CREATE INDEX IF NOT EXISTS idx_sensor_attachments_sensor ON sensor_attachments(device_id, sensor_id);

-- === USER IDENTITY & AUTH (Phase 1) ===

-- Custom roles — orgs can define as many as they want
-- level determines hierarchy: higher level = more permissions
CREATE TABLE IF NOT EXISTS roles (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    level INTEGER NOT NULL DEFAULT 0,          -- 0=viewer, 25=user, 50=manager, 75=admin, 100=owner
    description TEXT,
    permissions TEXT DEFAULT '[]',             -- JSON array of permission strings
    color TEXT,                                -- hex color for UI badge
    created_at TEXT DEFAULT (datetime('now','localtime'))
);

-- Seed default roles (idempotent — INSERT OR IGNORE)
INSERT OR IGNORE INTO roles (name, level, description, color) VALUES ('viewer', 0, 'Read-only access', '#585b70');
INSERT OR IGNORE INTO roles (name, level, description, color) VALUES ('user', 25, 'Standard user', '#89b4fa');
INSERT OR IGNORE INTO roles (name, level, description, color) VALUES ('manager', 50, 'Manage users and devices', '#a6e3a1');
INSERT OR IGNORE INTO roles (name, level, description, color) VALUES ('admin', 75, 'Full admin access', '#f9e2af');
INSERT OR IGNORE INTO roles (name, level, description, color) VALUES ('owner', 100, 'Instance owner', '#f38ba8');

-- Users (OAuth — no passwords, sign in with Google/Apple/Microsoft/GitHub)
CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL UNIQUE,
    display_name TEXT NOT NULL,
    avatar_url TEXT,
    role TEXT NOT NULL DEFAULT 'user',    -- instance role: 'owner','admin','user','viewer'
    power_lvl INTEGER,                   -- power level override (0-100). NULL = derive from role.
    is_active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT DEFAULT (datetime('now','localtime')),
    last_login TEXT
);

-- Seed default owner user (idempotent)
INSERT OR IGNORE INTO users (id, email, display_name, role) VALUES (1, 'owner@localhost', 'Tereseus', 'owner');

-- OAuth provider links (one user can link multiple providers)
CREATE TABLE IF NOT EXISTS user_oauth (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    provider TEXT NOT NULL,               -- 'google', 'apple', 'microsoft', 'github'
    provider_id TEXT NOT NULL,            -- provider's unique user ID (sub claim)
    provider_email TEXT,
    created_at TEXT DEFAULT (datetime('now','localtime')),
    UNIQUE(provider, provider_id)
);

-- Auth tokens (revocable, per-device)
CREATE TABLE IF NOT EXISTS api_tokens (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token TEXT NOT NULL UNIQUE,           -- crypto.randomBytes(32).hex
    name TEXT DEFAULT 'default',          -- "phone", "dashboard", "cli"
    scopes TEXT DEFAULT '["*"]',
    expires_at TEXT,
    last_used TEXT,
    created_at TEXT DEFAULT (datetime('now','localtime'))
);

CREATE INDEX IF NOT EXISTS idx_api_tokens_token ON api_tokens(token);
CREATE INDEX IF NOT EXISTS idx_user_oauth_provider ON user_oauth(provider, provider_id);

-- AI usage tracking — every API call logged with tokens and cost
CREATE TABLE IF NOT EXISTS ai_usage (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    caller TEXT NOT NULL,
    model TEXT NOT NULL,
    input_tokens INTEGER DEFAULT 0,
    output_tokens INTEGER DEFAULT 0,
    cost_cents REAL DEFAULT 0,
    prompt_preview TEXT,
    created_at TEXT DEFAULT (datetime('now','localtime'))
);

CREATE INDEX IF NOT EXISTS idx_ai_usage_caller ON ai_usage(caller);
CREATE INDEX IF NOT EXISTS idx_ai_usage_created ON ai_usage(created_at);

-- === THREE-TIER VECTOR MEMORY ===

-- Episodic memory — records of what happened (interactions, events, outcomes)
CREATE TABLE IF NOT EXISTS episodic_memories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    summary TEXT NOT NULL,
    detail TEXT DEFAULT '',
    episode_type TEXT DEFAULT 'interaction',  -- interaction, error, correction, decision
    outcome TEXT DEFAULT 'success',           -- success, failure, partial, unknown
    importance REAL DEFAULT 0.5,              -- 0.0-1.0, used for retrieval ranking
    session_id TEXT REFERENCES sessions(id),
    project_id INTEGER REFERENCES projects(id),
    embedding BLOB,                           -- vector embedding for semantic search
    created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE INDEX IF NOT EXISTS idx_episodic_created ON episodic_memories(created_at);
CREATE INDEX IF NOT EXISTS idx_episodic_project ON episodic_memories(project_id);
CREATE INDEX IF NOT EXISTS idx_episodic_importance ON episodic_memories(importance);

-- Semantic memory — knowledge graph (subject-predicate-object triples with contradiction detection)
CREATE TABLE IF NOT EXISTS semantic_facts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    subject TEXT NOT NULL,
    predicate TEXT NOT NULL,
    object TEXT NOT NULL,
    description TEXT DEFAULT '',
    category TEXT DEFAULT 'domain_knowledge',  -- user_preference, correction, domain_knowledge, project_fact
    confidence REAL DEFAULT 0.8,
    version INTEGER DEFAULT 1,
    previous_version_id INTEGER REFERENCES semantic_facts(id),
    valid_until TEXT,                          -- NULL = current, set when superseded
    embedding BLOB,
    created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE INDEX IF NOT EXISTS idx_semantic_subject ON semantic_facts(subject);
CREATE INDEX IF NOT EXISTS idx_semantic_category ON semantic_facts(category);
CREATE INDEX IF NOT EXISTS idx_semantic_valid ON semantic_facts(valid_until);

-- Procedural memory — learned multi-step procedures with success tracking
CREATE TABLE IF NOT EXISTS procedural_memories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    description TEXT NOT NULL,
    trigger_pattern TEXT DEFAULT '',           -- regex/keyword that activates this procedure
    steps TEXT NOT NULL DEFAULT '[]',          -- JSON array of step objects
    preconditions TEXT DEFAULT '[]',
    postconditions TEXT DEFAULT '[]',
    success_count INTEGER DEFAULT 0,
    failure_count INTEGER DEFAULT 0,
    embedding BLOB,
    created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE INDEX IF NOT EXISTS idx_procedural_name ON procedural_memories(name);

-- Evolution versions — tracks config file changes from the self-improvement pipeline
CREATE TABLE IF NOT EXISTS evolution_versions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    config_file TEXT NOT NULL,
    version INTEGER NOT NULL,
    content TEXT NOT NULL,
    diff_from_previous TEXT,
    validation_result TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE INDEX IF NOT EXISTS idx_evolution_file ON evolution_versions(config_file, version);

-- Client logs — universal telemetry from browsers, phones, ESP32s, pendants
CREATE TABLE IF NOT EXISTS client_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    device_id TEXT NOT NULL,              -- hostname, user-agent hash, or device serial
    device_type TEXT NOT NULL DEFAULT 'browser',  -- browser, phone, esp32, pendant
    level TEXT NOT NULL DEFAULT 'error',  -- error, warn, info, debug
    source TEXT NOT NULL DEFAULT 'console', -- console, crash, network, sensor, app
    message TEXT NOT NULL,
    meta TEXT DEFAULT '{}',               -- JSON: url, stack, user-agent, etc.
    created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE INDEX IF NOT EXISTS idx_client_logs_device ON client_logs(device_id);
CREATE INDEX IF NOT EXISTS idx_client_logs_level ON client_logs(level);
CREATE INDEX IF NOT EXISTS idx_client_logs_created ON client_logs(created_at);
CREATE INDEX IF NOT EXISTS idx_client_logs_device_type ON client_logs(device_type);

-- Alerts — system alerts with lifecycle (open → acknowledged → resolved / dismissed)
CREATE TABLE IF NOT EXISTS alerts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    alert_type TEXT NOT NULL,                      -- 'orphan_processes', 'service_crash', 'pty_exit', etc.
    severity TEXT NOT NULL DEFAULT 'warning',       -- 'info', 'warning', 'critical'
    title TEXT NOT NULL,
    detail TEXT DEFAULT '',                         -- full context: what happened, PIDs, timestamps
    status TEXT NOT NULL DEFAULT 'open',            -- 'open', 'acknowledged', 'resolved', 'dismissed'
    resolution TEXT,                                -- how it was fixed (filled on resolve)
    resolved_by TEXT,                               -- 'user', 'system', 'auto'
    org_id TEXT DEFAULT 'org_personal',
    created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
    resolved_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_alerts_status ON alerts(status);
CREATE INDEX IF NOT EXISTS idx_alerts_type ON alerts(alert_type);
CREATE INDEX IF NOT EXISTS idx_alerts_created ON alerts(created_at);
CREATE INDEX IF NOT EXISTS idx_alerts_severity ON alerts(severity);

-- Full-text search index for events — enables instant ranked search across all history
-- content_text stores the clean extracted text, synced on insert via application code
CREATE VIRTUAL TABLE IF NOT EXISTS events_fts USING fts5(
    content_text,
    content='',           -- external content mode (we manage the data)
    tokenize='porter unicode61'  -- stemming + unicode support
);

-- === THREE-TIER VECTOR MEMORY (inspired by Phantom) ===

-- Episodic memory — what happened (task summaries, outcomes, lessons learned)
CREATE TABLE IF NOT EXISTS episodic_memories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    summary TEXT NOT NULL,
    detail TEXT,
    episode_type TEXT NOT NULL DEFAULT 'interaction',  -- interaction, task, error, observation, voice
    outcome TEXT DEFAULT 'success',                     -- success, failure, partial, abandoned
    importance REAL DEFAULT 0.5,                        -- 0.0-1.0
    decay_rate REAL DEFAULT 0.01,                       -- exponential decay factor
    access_count INTEGER DEFAULT 0,
    session_id TEXT,
    project_id INTEGER REFERENCES projects(id),
    embedding BLOB,                                     -- float32 array as binary
    created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
    last_accessed TEXT
);

CREATE INDEX IF NOT EXISTS idx_episodic_type ON episodic_memories(episode_type);
CREATE INDEX IF NOT EXISTS idx_episodic_created ON episodic_memories(created_at);
CREATE INDEX IF NOT EXISTS idx_episodic_importance ON episodic_memories(importance DESC);

-- Semantic memory — knowledge graph (subject-predicate-object facts)
CREATE TABLE IF NOT EXISTS semantic_facts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    subject TEXT NOT NULL,
    predicate TEXT NOT NULL,
    object TEXT NOT NULL,
    description TEXT,                                   -- natural language description
    category TEXT DEFAULT 'domain_knowledge',           -- user_preference, domain_knowledge, codebase, process, tool, team
    confidence REAL DEFAULT 0.8,
    version INTEGER DEFAULT 1,
    previous_version_id INTEGER REFERENCES semantic_facts(id),
    valid_from TEXT NOT NULL DEFAULT (datetime('now','localtime')),
    valid_until TEXT,                                    -- set when superseded
    embedding BLOB,
    created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE INDEX IF NOT EXISTS idx_semantic_subject ON semantic_facts(subject);
CREATE INDEX IF NOT EXISTS idx_semantic_category ON semantic_facts(category);
CREATE INDEX IF NOT EXISTS idx_semantic_valid ON semantic_facts(valid_until);

-- Procedural memory — learned multi-step procedures
CREATE TABLE IF NOT EXISTS procedural_memories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    description TEXT NOT NULL,
    trigger_pattern TEXT,                                -- when to suggest this procedure
    steps TEXT NOT NULL DEFAULT '[]',                    -- JSON array of step objects
    preconditions TEXT DEFAULT '[]',
    postconditions TEXT DEFAULT '[]',
    success_count INTEGER DEFAULT 0,
    failure_count INTEGER DEFAULT 0,
    embedding BLOB,
    created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
    last_used TEXT
);

CREATE INDEX IF NOT EXISTS idx_procedural_name ON procedural_memories(name);

-- Evolution config versions — tracks every change the evolution pipeline makes
CREATE TABLE IF NOT EXISTS evolution_versions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    config_file TEXT NOT NULL,                           -- e.g. 'persona', 'strategies', 'domain-knowledge'
    version INTEGER NOT NULL,
    content TEXT NOT NULL,
    diff_from_previous TEXT,
    validation_result TEXT,                              -- JSON: which gates passed/failed
    created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE INDEX IF NOT EXISTS idx_evolution_file ON evolution_versions(config_file, version DESC);

-- === MULTI-ORG (Tier 0) ===

CREATE TABLE IF NOT EXISTS orgs (
  id TEXT PRIMARY KEY,
  slug TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  logo_url TEXT,
  color_primary TEXT,
  color_secondary TEXT,
  policy_blackout_allowed INTEGER DEFAULT 1,
  policy_incognito_allowed INTEGER DEFAULT 1,
  policy_sensor_rules TEXT,
  policy_export_rules TEXT,
  policy_data_retention_days INTEGER,
  created_at INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER) * 1000)
);

CREATE TABLE IF NOT EXISTS memberships (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  org_id TEXT NOT NULL,
  role_id INTEGER,
  joined_at INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER) * 1000),
  left_at INTEGER,
  permissions_json TEXT,
  UNIQUE(user_id, org_id)
);
CREATE INDEX IF NOT EXISTS idx_memberships_user ON memberships(user_id);
CREATE INDEX IF NOT EXISTS idx_memberships_org ON memberships(org_id);

CREATE TABLE IF NOT EXISTS zones (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  org_id TEXT NOT NULL,
  name TEXT NOT NULL,
  polygon_geojson TEXT NOT NULL,
  sensor_rules_json TEXT,
  tool_rules_json TEXT,
  created_at INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER) * 1000)
);
CREATE INDEX IF NOT EXISTS idx_zones_org ON zones(org_id);

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  org_id TEXT NOT NULL,
  user_id INTEGER,
  action TEXT NOT NULL,
  target TEXT,
  metadata_json TEXT,
  ts INTEGER NOT NULL,
  signature TEXT,
  prev_hash TEXT
);
CREATE INDEX IF NOT EXISTS idx_audit_org_ts ON audit_log(org_id, ts);

CREATE TABLE IF NOT EXISTS incognito_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  payload TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_incognito_expires ON incognito_events(expires_at);

CREATE TABLE IF NOT EXISTS sensor_toggles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  device_id INTEGER NOT NULL,
  org_id TEXT NOT NULL,
  sensor TEXT NOT NULL,
  enabled INTEGER NOT NULL,
  cadence_seconds INTEGER,
  forced_by_org INTEGER DEFAULT 0,
  updated_at INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER) * 1000),
  UNIQUE(user_id, device_id, org_id, sensor)
);

CREATE TABLE IF NOT EXISTS org_invites (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  org_id TEXT NOT NULL,
  token TEXT NOT NULL UNIQUE,
  role_id INTEGER,                    -- role to assign on join (NULL = default 'user')
  created_by INTEGER NOT NULL,        -- user_id who created the invite
  email TEXT,                         -- optional: restrict to specific email
  max_uses INTEGER DEFAULT 1,         -- how many times this token can be used
  use_count INTEGER DEFAULT 0,
  expires_at INTEGER,                 -- NULL = never expires
  created_at INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER) * 1000)
);
CREATE INDEX IF NOT EXISTS idx_org_invites_token ON org_invites(token);
CREATE INDEX IF NOT EXISTS idx_org_invites_org ON org_invites(org_id);

-- Cross-org data sharing — tracks which orgs share data with which
CREATE TABLE IF NOT EXISTS org_shares (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_org_id TEXT NOT NULL,
  target_org_id TEXT NOT NULL,
  share_type TEXT NOT NULL DEFAULT 'readonly',  -- readonly, readwrite
  tables TEXT NOT NULL DEFAULT '[]',            -- JSON array of table names shared
  created_by INTEGER NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER) * 1000),
  revoked_at INTEGER,
  UNIQUE(source_org_id, target_org_id)
);
CREATE INDEX IF NOT EXISTS idx_org_shares_source ON org_shares(source_org_id);
CREATE INDEX IF NOT EXISTS idx_org_shares_target ON org_shares(target_org_id);

-- Teams — groups within an org
CREATE TABLE IF NOT EXISTS teams (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  org_id TEXT NOT NULL,
  name TEXT NOT NULL,
  slug TEXT NOT NULL,
  description TEXT,
  color TEXT DEFAULT '#89b4fa',
  created_by INTEGER NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER) * 1000),
  UNIQUE(org_id, slug)
);
CREATE INDEX IF NOT EXISTS idx_teams_org ON teams(org_id);

-- Team members — users belong to teams within an org
CREATE TABLE IF NOT EXISTS team_members (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  team_id INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL,
  role TEXT NOT NULL DEFAULT 'member',  -- member, lead
  joined_at INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER) * 1000),
  UNIQUE(team_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_team_members_team ON team_members(team_id);
CREATE INDEX IF NOT EXISTS idx_team_members_user ON team_members(user_id);

-- Seed personal org (idempotent)
INSERT OR IGNORE INTO orgs (id, slug, name, color_primary)
VALUES ('org_personal', 'personal', 'Personal', '#f5c2e7');

-- Seed default owner into personal org
INSERT OR IGNORE INTO memberships (user_id, org_id, role_id)
SELECT 1, 'org_personal', r.id FROM roles r WHERE r.name = 'owner';
