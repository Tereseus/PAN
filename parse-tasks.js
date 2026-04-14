const data = JSON.parse(require('fs').readFileSync(0, 'utf-8'));
const tasks = [];
data.milestones?.forEach(m => {
  m.tasks?.forEach(t => {
    if (t.status === 'in_progress' || (t.status === 'todo' && t.priority === 1)) {
      tasks.push(t);
    }
  });
});
tasks.sort((a,b) => (a.priority||999) - (b.priority||999));
tasks.forEach(t => console.log(`[${t.status} P${t.priority}] ${t.title}`));
