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
    created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
    completed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_tasks_project ON project_tasks(project_id);
CREATE INDEX IF NOT EXISTS idx_tasks_milestone ON project_tasks(milestone_id);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON project_tasks(status);

-- Track which project tabs are open in WezTerm for session restore
CREATE TABLE IF NOT EXISTS open_tabs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER REFERENCES projects(id) ON DELETE CASCADE,
    pane_id INTEGER,
    tab_index INTEGER DEFAULT 0,
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

-- Users (OAuth — no passwords, sign in with Google/Apple/Microsoft/GitHub)
CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL UNIQUE,
    display_name TEXT NOT NULL,
    avatar_url TEXT,
    role TEXT NOT NULL DEFAULT 'user',    -- instance role: 'owner','admin','user','viewer'
    is_active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT DEFAULT (datetime('now','localtime')),
    last_login TEXT
);

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

-- Full-text search index for events — enables instant ranked search across all history
-- content_text stores the clean extracted text, synced on insert via application code
CREATE VIRTUAL TABLE IF NOT EXISTS events_fts USING fts5(
    content_text,
    content='',           -- external content mode (we manage the data)
    tokenize='porter unicode61'  -- stemming + unicode support
);
