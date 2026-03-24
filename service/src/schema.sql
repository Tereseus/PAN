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

-- Full-text search index for events — enables instant ranked search across all history
-- content_text stores the clean extracted text, synced on insert via application code
CREATE VIRTUAL TABLE IF NOT EXISTS events_fts USING fts5(
    content_text,
    content='',           -- external content mode (we manage the data)
    tokenize='porter unicode61'  -- stemming + unicode support
);
