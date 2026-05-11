/**
 * ANTS Trail — Roadmap Engine (server.js)
 * Node.js + Express backend
 * Run: npm install && node server.js
 * Open: http://localhost:3000
 */

const express = require('express');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = 3000;

// ─── Middleware ───────────────────────────────────────────────────────────────
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─── Load course matrix once at startup ──────────────────────────────────────
let courseMatrix;
try {
  const raw = fs.readFileSync(path.join(__dirname, 'course_matrix.json'), 'utf-8');
  courseMatrix = JSON.parse(raw);
  console.log(`✅ Loaded course_matrix.json (schema v${courseMatrix.schema_version})`);
  console.log(`   📚 Mandatory courses: ${courseMatrix.mandatory_courses.length}`);
  console.log(`   👤 Profiles: ${courseMatrix.profiles.length}`);
} catch (err) {
  console.error('❌ Failed to load course_matrix.json:', err.message);
  process.exit(1);
}

// ─── In-memory progress store (simulates a DB for local testing) ──────────────
// Structure: { [sessionId]: { [courseId]: 'not_started' | 'in_progress' | 'completed' } }
const progressStore = {};

// ─── Helper: derive profile key from form input ───────────────────────────────
function deriveProfileKey(primaryTool, experienceLevel) {
  const toolMap = {
    'Tosca': 'tosca',
    'TestComplete': 'testcomplete',
    'JMeter': 'perf',
    'Postman': 'api',
    'Manual QA': 'manual',
    'Playwright': 'playwright',
    'Selenium': 'selenium'
  };
  const lvlMap = {
    'Junior': 'junior',
    'Mid': 'mid',
    'Senior': 'senior',
    'Architect': 'architect'
  };
  const tool = toolMap[primaryTool] ?? 'unknown';
  const level = lvlMap[experienceLevel] ?? 'mid';
  return `${tool}_${level}`;
}

// ─── Helper: build roadmap from matrix ────────────────────────────────────────
function getRoadmap(profileKey) {
  const mandatory = courseMatrix.mandatory_courses
    .slice()
    .sort((a, b) => a.sequence_order - b.sequence_order);

  const profile = courseMatrix.profiles.find(p => p.profile_key === profileKey);

  if (!profile) {
    // Fallback: mandatory courses only
    return {
      profile_key: profileKey,
      display_label: 'General ANTS Path',
      target_role: 'AI-Enabled Test Engineer',
      duration_weeks: '8–12',
      key_outcome: 'Complete the mandatory AI and Playwright baseline',
      courses: mandatory,
      fallback: true,
      fallback_notice: 'No specific roadmap found for your profile. Showing the mandatory baseline for all engineers.'
    };
  }

  // Merge: mandatory first (seq 1–6), then profile-specific (seq continues)
  const profileCourses = profile.courses
    .slice()
    .sort((a, b) => a.sequence_order - b.sequence_order);

  return {
    profile_key: profile.profile_key,
    display_label: profile.display_label,
    target_role: profile.target_role,
    duration_weeks: profile.duration_weeks,
    key_outcome: profile.key_outcome,
    courses: [...mandatory, ...profileCourses],
    fallback: false
  };
}

// ─── Helper: calculate completion % ──────────────────────────────────────────
function calcCompletion(sessionId, courses) {
  const progress = progressStore[sessionId] || {};
  const total = courses.length;
  if (total === 0) return 0;
  const completed = courses.filter(c => progress[c.course_id] === 'completed').length;
  return Math.round((completed / total) * 100);
}

// ─── Routes ───────────────────────────────────────────────────────────────────

// GET /api/profiles — list all available profiles for the dropdown
app.get('/api/profiles', (req, res) => {
  const tools = ['Manual QA', 'Tosca', 'TestComplete', 'JMeter', 'Postman', 'Playwright'];
  const levels = ['Junior', 'Mid', 'Senior', 'Architect'];

  const profiles = courseMatrix.profiles.map(p => ({
    profile_key: p.profile_key,
    display_label: p.display_label,
    primary_tool: p.primary_tool,
    experience_level: p.experience_level,
    duration_weeks: p.duration_weeks,
    target_role: p.target_role
  }));

  res.json({ tools, levels, profiles });
});

// POST /api/roadmap — generate roadmap for a given tool + level
app.post('/api/roadmap', (req, res) => {
  const { primaryTool, experienceLevel, sessionId } = req.body;

  if (!primaryTool || !experienceLevel) {
    return res.status(400).json({ error: 'primaryTool and experienceLevel are required' });
  }

  const sid = sessionId || `session_${Date.now()}`;
  const profileKey = deriveProfileKey(primaryTool, experienceLevel);
  const roadmap = getRoadmap(profileKey);

  // Initialise progress for all courses (not_started by default)
  if (!progressStore[sid]) {
    progressStore[sid] = {};
  }
  roadmap.courses.forEach(course => {
    if (!progressStore[sid][course.course_id]) {
      progressStore[sid][course.course_id] = 'not_started';
    }
  });

  const completion_pct = calcCompletion(sid, roadmap.courses);

  res.json({
    session_id: sid,
    profile_key: profileKey,
    roadmap,
    progress: progressStore[sid],
    completion_pct,
    total_courses: roadmap.courses.length,
    total_duration_hours: Math.round(
      roadmap.courses.reduce((sum, c) => sum + c.duration_minutes, 0) / 60
    )
  });
});

// PATCH /api/progress — update course state (upsert, matches tech spec)
app.patch('/api/progress', (req, res) => {
  const { sessionId, courseId, newState } = req.body;
  const validStates = ['not_started', 'in_progress', 'completed'];

  if (!sessionId || !courseId || !newState) {
    return res.status(400).json({ error: 'sessionId, courseId, and newState are required' });
  }
  if (!validStates.includes(newState)) {
    return res.status(400).json({ error: `newState must be one of: ${validStates.join(', ')}` });
  }
  if (!progressStore[sessionId]) {
    return res.status(404).json({ error: 'Session not found. Generate a roadmap first.' });
  }

  // UPSERT
  progressStore[sessionId][courseId] = newState;

  // Recalculate completion %
  const allCourseIds = Object.keys(progressStore[sessionId]);
  const completed = allCourseIds.filter(id => progressStore[sessionId][id] === 'completed').length;
  const completion_pct = Math.round((completed / allCourseIds.length) * 100);

  res.json({
    course_id: courseId,
    state: newState,
    completion_pct,
    updated_at: new Date().toISOString()
  });
});

// GET /api/progress/:sessionId — get full progress for a session
app.get('/api/progress/:sessionId', (req, res) => {
  const { sessionId } = req.params;
  if (!progressStore[sessionId]) {
    return res.status(404).json({ error: 'Session not found.' });
  }

  const progress = progressStore[sessionId];
  const allCourseIds = Object.keys(progress);
  const completed = allCourseIds.filter(id => progress[id] === 'completed').length;
  const inProgress = allCourseIds.filter(id => progress[id] === 'in_progress').length;
  const completion_pct = allCourseIds.length > 0
    ? Math.round((completed / allCourseIds.length) * 100)
    : 0;

  res.json({
    session_id: sessionId,
    progress,
    stats: {
      total: allCourseIds.length,
      completed,
      in_progress: inProgress,
      not_started: allCourseIds.length - completed - inProgress,
      completion_pct
    }
  });
});

// GET /api/matrix/stats — overview of what's in the matrix (useful for admin)
app.get('/api/matrix/stats', (req, res) => {
  res.json({
    schema_version: courseMatrix.schema_version,
    mandatory_courses: courseMatrix.mandatory_courses.length,
    total_profiles: courseMatrix.profiles.length,
    profiles: courseMatrix.profiles.map(p => ({
      key: p.profile_key,
      label: p.display_label,
      courses: p.courses.length,
      duration_weeks: p.duration_weeks
    }))
  });
});

// ─── Start server (local only) ────────────────────────────────────────────────
// When running locally, app.listen() starts the server.
// On Vercel, the module.exports below takes over — Vercel handles the port.
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`\n🐜 ANTS Trail Engine running at http://localhost:${PORT}`);
    console.log(`\nAvailable endpoints:`);
    console.log(`  GET  /api/profiles           — list tools, levels, profiles`);
    console.log(`  POST /api/roadmap            — generate roadmap { primaryTool, experienceLevel }`);
    console.log(`  PATCH /api/progress          — update course state { sessionId, courseId, newState }`);
    console.log(`  GET  /api/progress/:id       — get session progress`);
    console.log(`  GET  /api/matrix/stats       — matrix overview\n`);
  });
}

// ─── Export for Vercel serverless ─────────────────────────────────────────────
module.exports = app;
