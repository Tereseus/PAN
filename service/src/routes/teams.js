// Teams — group users within an org
//
// Routes:
//   GET    /                    — list teams in current org
//   POST   /                    — create team
//   GET    /:id                 — get team details + members
//   PUT    /:id                 — update team (name, description, color)
//   DELETE /:id                 — delete team
//   POST   /:id/members        — add member to team
//   PUT    /:id/members/:userId — change member role (member/lead)
//   DELETE /:id/members/:userId — remove member from team
//   GET    /:id/projects        — list projects assigned to team
//   GET    /:id/tasks           — list tasks assigned to team

import { Router } from 'express';
import { all, get, run, insert, db } from '../db.js';
import { auditLog } from '../middleware/org-context.js';

const router = Router();

// Slugify helper
function slugify(name) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

// ── GET / — list teams in current org ──
router.get('/', (req, res) => {
  const orgId = req.org_id || 'org_personal';
  try {
    const teams = all(
      `SELECT t.*, COUNT(tm.id) as member_count
       FROM teams t
       LEFT JOIN team_members tm ON tm.team_id = t.id
       WHERE t.org_id = :orgId
       GROUP BY t.id
       ORDER BY t.name`,
      { ':orgId': orgId }
    );
    res.json({ ok: true, teams });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── POST / — create team ──
router.post('/', (req, res) => {
  const orgId = req.org_id || 'org_personal';
  const userId = req.user?.id || 1;
  const { name, description, color } = req.body;

  if (!name || !name.trim()) {
    return res.status(400).json({ error: 'Team name is required' });
  }

  const slug = slugify(name.trim());

  try {
    const existing = get(
      `SELECT id FROM teams WHERE org_id = :orgId AND slug = :slug`,
      { ':orgId': orgId, ':slug': slug }
    );
    if (existing) {
      return res.status(409).json({ error: 'Team with that name already exists in this org' });
    }

    const teamId = insert(
      `INSERT INTO teams (org_id, name, slug, description, color, created_by)
       VALUES (:orgId, :name, :slug, :desc, :color, :uid)`,
      { ':orgId': orgId, ':name': name.trim(), ':slug': slug, ':desc': description || null, ':color': color || '#89b4fa', ':uid': userId }
    );

    // Creator auto-joins as lead
    run(
      `INSERT INTO team_members (team_id, user_id, role) VALUES (:tid, :uid, 'lead')`,
      { ':tid': teamId, ':uid': userId }
    );

    auditLog(req, 'team.create', orgId, { team_id: teamId, name: name.trim() });
    res.json({ ok: true, team: { id: teamId, name: name.trim(), slug, org_id: orgId, member_count: 1 } });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── GET /:id — team details + members ──
router.get('/:id', (req, res) => {
  const teamId = req.params.id;
  try {
    const team = get(`SELECT * FROM teams WHERE id = :id`, { ':id': teamId });
    if (!team) return res.status(404).json({ error: 'Team not found' });

    const members = all(
      `SELECT tm.*, u.display_name, u.email, u.avatar_url
       FROM team_members tm
       JOIN users u ON u.id = tm.user_id
       WHERE tm.team_id = :tid
       ORDER BY tm.role DESC, u.display_name`,
      { ':tid': teamId }
    );

    res.json({ ok: true, team, members });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── PUT /:id — update team ──
router.put('/:id', (req, res) => {
  const teamId = req.params.id;
  const { name, description, color } = req.body;

  try {
    const team = get(`SELECT * FROM teams WHERE id = :id`, { ':id': teamId });
    if (!team) return res.status(404).json({ error: 'Team not found' });

    const updates = [];
    const params = { ':id': teamId };

    if (name !== undefined) {
      updates.push('name = :name, slug = :slug');
      params[':name'] = name.trim();
      params[':slug'] = slugify(name.trim());
    }
    if (description !== undefined) {
      updates.push('description = :desc');
      params[':desc'] = description;
    }
    if (color !== undefined) {
      updates.push('color = :color');
      params[':color'] = color;
    }

    if (updates.length > 0) {
      run(`UPDATE teams SET ${updates.join(', ')} WHERE id = :id`, params);
    }

    auditLog(req, 'team.update', team.org_id, { team_id: teamId });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── DELETE /:id — delete team ──
router.delete('/:id', (req, res) => {
  const teamId = req.params.id;
  try {
    const team = get(`SELECT * FROM teams WHERE id = :id`, { ':id': teamId });
    if (!team) return res.status(404).json({ error: 'Team not found' });

    // Unassign projects and tasks from this team
    run(`UPDATE projects SET team_id = NULL WHERE team_id = :tid`, { ':tid': teamId });
    run(`UPDATE project_tasks SET team_id = NULL WHERE team_id = :tid`, { ':tid': teamId });

    // Delete team (cascade deletes team_members)
    run(`DELETE FROM teams WHERE id = :id`, { ':id': teamId });

    auditLog(req, 'team.delete', team.org_id, { team_id: teamId, name: team.name });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── POST /:id/members — add member ──
router.post('/:id/members', (req, res) => {
  const teamId = req.params.id;
  const { user_id, role } = req.body;

  if (!user_id) return res.status(400).json({ error: 'user_id required' });

  try {
    const team = get(`SELECT * FROM teams WHERE id = :id`, { ':id': teamId });
    if (!team) return res.status(404).json({ error: 'Team not found' });

    // Check user is member of the org
    const orgMember = get(
      `SELECT id FROM memberships WHERE user_id = :uid AND org_id = :oid AND left_at IS NULL`,
      { ':uid': user_id, ':oid': team.org_id }
    );
    if (!orgMember) return res.status(400).json({ error: 'User is not a member of this org' });

    run(
      `INSERT OR IGNORE INTO team_members (team_id, user_id, role) VALUES (:tid, :uid, :role)`,
      { ':tid': teamId, ':uid': user_id, ':role': role || 'member' }
    );

    auditLog(req, 'team.member.add', team.org_id, { team_id: teamId, user_id });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── PUT /:id/members/:userId — change member role ──
router.put('/:id/members/:userId', (req, res) => {
  const { id: teamId, userId } = req.params;
  const { role } = req.body;

  if (!role || !['member', 'lead'].includes(role)) {
    return res.status(400).json({ error: 'role must be "member" or "lead"' });
  }

  try {
    run(
      `UPDATE team_members SET role = :role WHERE team_id = :tid AND user_id = :uid`,
      { ':role': role, ':tid': teamId, ':uid': userId }
    );
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── DELETE /:id/members/:userId — remove member ──
router.delete('/:id/members/:userId', (req, res) => {
  const { id: teamId, userId } = req.params;
  try {
    const team = get(`SELECT * FROM teams WHERE id = :id`, { ':id': teamId });
    run(
      `DELETE FROM team_members WHERE team_id = :tid AND user_id = :uid`,
      { ':tid': teamId, ':uid': userId }
    );
    auditLog(req, 'team.member.remove', team?.org_id, { team_id: teamId, user_id: userId });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── GET /:id/projects — projects assigned to this team ──
router.get('/:id/projects', (req, res) => {
  const teamId = req.params.id;
  try {
    const projects = all(
      `SELECT * FROM projects WHERE team_id = :tid ORDER BY name`,
      { ':tid': teamId }
    );
    res.json({ ok: true, projects });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── GET /:id/tasks — tasks assigned to this team ──
router.get('/:id/tasks', (req, res) => {
  const teamId = req.params.id;
  try {
    const tasks = all(
      `SELECT t.*, p.name as project_name, u.display_name as assignee_name
       FROM project_tasks t
       LEFT JOIN projects p ON p.id = t.project_id
       LEFT JOIN users u ON u.id = t.assigned_to
       WHERE t.team_id = :tid
       ORDER BY t.priority DESC, t.created_at DESC`,
      { ':tid': teamId }
    );
    res.json({ ok: true, tasks });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── GET /user/:userId — list teams a user belongs to ──
router.get('/user/:userId', (req, res) => {
  const userId = req.params.userId;
  try {
    const teams = all(
      `SELECT t.*, tm.role as team_role
       FROM team_members tm
       JOIN teams t ON t.id = tm.team_id
       WHERE tm.user_id = :uid
       ORDER BY t.name`,
      { ':uid': userId }
    );
    res.json({ ok: true, teams });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

export default router;
