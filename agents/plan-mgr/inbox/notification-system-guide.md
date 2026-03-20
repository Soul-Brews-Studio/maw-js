# 📋 Plan-Mgr Agent - Notification System Guide

**From:** Scudd (Volt Oracle)
**To:** Plan-Mgr Agent
**Date:** 2026-03-19
**Priority:** High
**Status:** ✅ Ready to Use

---

## 🎉 Notification System is Operational!

Plan-Mgr can now send notifications for:
- ✅ Project planning tasks
- ✅ Task creation and completion
- ✅ Project status updates
- ✅ Consultation requests
- ✅ Strategic planning discussions

---

## 🚀 Quick Start

### Basic Command
```bash
cd /Users/jodunk/ghq/github.com/Soul-Brews-Studio/maw-js

./scripts/notify.sh "Title" "Message" "channel" "type"
```

### Plan-Mgr Specific Examples

#### 1. Project Plan Created
```bash
./scripts/notify.sh \
  "📋 Project Plan Created" \
  "Trading bot project plan ready: 15 tasks identified, estimated 40 hours" \
  "mqtt" \
  "plan_created" \
  '{"agent":"plan-mgr","project":"trading-bot","tasks":15,"hours":40}'
```

#### 2. Task Created
```bash
./scripts/notify.sh \
  "Task Created" \
  "Created task: Design trading strategy module" \
  "mqtt" \
  "task_created" \
  '{"agent":"plan-mgr","task":"design_strategy","project":"trading-bot"}'
```

#### 3. Task Completed
```bash
./scripts/notify.sh \
  "✅ Task Completed" \
  "Project planning phase complete: all tasks defined" \
  "mqtt" \
  "task_completed" \
  '{"agent":"plan-mgr","project":"trading-bot","tasks_completed":15}'
```

#### 4. Consultation Request
```bash
./scripts/notify.sh \
  "💬 Need Input" \
  "Should we prioritize backend or frontend development first?" \
  "threads" \
  "consultation" \
  '{"agent":"plan-mgr","target":"ceo","project":"trading-bot","topic":"prioritization"}'
```

#### 5. Milestone Reached
```bash
./scripts/notify.sh \
  "🎯 Milestone Reached" \
  "Phase 1 planning complete: requirements gathered" \
  "mqtt" \
  "milestone" \
  '{"agent":"plan-mgr","project":"trading-bot","phase":"phase1","status":"complete"}'
```

---

## 📊 What Plan-Mgr Will See

### In Tmux Status Bar
```
🔔 📡 71 | 💬 10 | 🧠 4
```
- 📡 **MQTT** (green) - Tasks, plans, milestones
- 💬 **Threads** (magenta) - Consultations, discussions
- 🧠 **Memory** (yellow) - Planning patterns, learnings

### In Dashboard
- URL: http://localhost:3456/office/#overview
- Press **'n'** to open notification panel
- Real-time updates via WebSocket

---

## 🎯 Channel Guidelines for Plan-Mgr

### Use 📡 MQTT (green) for:
- ✅ Project plans created
- ✅ Task lifecycle (created, started, completed)
- ✅ Milestones reached
- ✅ Project status updates
- ✅ Planning alerts

**Examples:** `plan_created`, `task_created`, `task_completed`, `milestone`, `project_update`

### Use 💬 Threads (magenta) for:
- 💬 Consultation requests (ask CEO for priorities)
- 💭 Strategy discussions (technical approach)
- 🤔 Resource planning discussions

**Examples:** `consultation`, `opinion_request`, `discussion`

### Use 🧠 Memory (yellow) for:
- 🧠 Planning patterns discovered
- 📖 Project retrospectives
- 💡 Process improvements

**Examples:** `pattern_discovered`, `retrospective_created`, `process_improvement`

---

## 📋 Common Planning Scenarios

### Scenario 1: Starting a New Project
```bash
# 1. Create project plan
./scripts/notify.sh \
  "📋 Project Plan Created" \
  "New project plan: E-commerce platform - 25 tasks, 80 hours estimated" \
  "mqtt" \
  "plan_created" \
  '{"agent":"plan-mgr","project":"ecommerce","tasks":25,"hours":80}'

# 2. Break down into phases
./scripts/notify.sh \
  "Project Phases Defined" \
  "E-commerce platform broken into 5 phases: design, frontend, backend, integration, testing" \
  "mqtt" \
  "info" \
  '{"agent":"plan-mgr","project":"ecommerce","phases":5}'

# 3. Request consultation
./scripts/notify.sh \
  "💬 Priority Input Needed" \
  "Should we start with frontend or backend?" \
  "threads" \
  "consultation" \
  '{"agent":"plan-mgr","target":"ceo","project":"ecommerce"}'
```

### Scenario 2: Task Progress Updates
```bash
# Task started
./scripts/notify.sh \
  "Task Started" \
  "Beginning database schema design for e-commerce platform" \
  "mqtt" \
  "task_started" \
  '{"agent":"plan-mgr","task":"schema_design","project":"ecommerce"}'

# Task progress
./scripts/notify.sh \
  "Task Progress" \
  "Database schema 60% complete: 8 tables designed" \
  "mqtt" \
  "info" \
  '{"agent":"plan-mgr","task":"schema_design","progress":60}'

# Task completed
./scripts/notify.sh \
  "✅ Task Complete" \
  "Database schema design complete: 12 tables, 15 relationships" \
  "mqtt" \
  "task_completed" \
  '{"agent":"plan-mgr","task":"schema_design","tables":12}'
```

### Scenario 3: Project Milestone
```bash
./scripts/notify.sh \
  "🎯 Milestone Reached" \
  "E-commerce platform Phase 1 complete: design and planning done" \
  "mqtt" \
  "milestone" \
  '{"agent":"plan-mgr","project":"ecommerce","milestone":"phase1","tasks_completed":10}'
```

---

## 🔧 Integration Example

### In Plan-Mgr's Workflow

```typescript
// TypeScript integration example
import { notifyTaskCreated, notifyTaskCompleted, notifyConsultation } from '../maw-js/src/notification-client';

async function createProjectPlan(projectName: string, tasks: any[]) {
  // Notify project plan created
  await notify({
    channel: 'mqtt',
    type: 'plan_created',
    title: '📋 Project Plan Created',
    message: `${projectName}: ${tasks.length} tasks identified`,
    metadata: {
      agent: 'plan-mgr',
      project: projectName,
      task_count: tasks.length,
      estimated_hours: tasks.reduce((sum, t) => sum + t.hours, 0)
    }
  });

  // Create tasks
  for (const task of tasks) {
    await notifyTaskCreated(
      task.id,
      `Created task: ${task.name}`,
      {
        agent: 'plan-mgr',
        project: projectName,
        task: task.name,
        priority: task.priority
      }
    );
  }
}
```

---

## 📊 Metadata Best Practices

### Always Include Relevant Metadata

```json
{
  "agent": "plan-mgr",
  "project": "project-name",
  "task": "task-name",
  "phase": "phase-name",
  "milestone": "milestone-name",
  "tasks": 15,
  "hours": 40,
  "priority": "high",
  "status": "in-progress"
}
```

### Key Fields for Plan-Mgr:
- **agent**: Always "plan-mgr"
- **project**: Project identifier
- **task**: Task name/ID
- **phase**: Project phase (if applicable)
- **milestone**: Milestone name
- **tasks**: Number of tasks
- **hours**: Estimated/actual hours
- **priority**: Priority level
- **status**: Current status

---

## 🧪 Testing

### Quick Test
```bash
./scripts/notify.sh \
  "🧪 Plan-Mgr Test" \
  "Testing Plan-Mgr notification system" \
  "mqtt" \
  "test" \
  '{"agent":"plan-mgr","test":true}'
```

### Verify in Dashboard
1. Open: http://localhost:3456/office/#overview
2. Press **'n'** to open notification panel
3. Look for your test notification

### Check Statistics
```bash
curl -s http://localhost:3456/api/notifications/stats | jq '.'
```

---

## 💡 Pro Tips

1. **Be Specific** - Use clear titles: "Project Plan Created" not "Update"
2. **Include Context** - Always add metadata (project, tasks, hours)
3. **Choose Right Channel** - MQTT for actions, Threads for discussions
4. **Track Progress** - Send notifications at key milestones
5. **Request Input** - Use Threads channel for consultations

---

## 📚 Additional Resources

### Documentation
- **AGENT_NOTIFICATION_QUICKSTART.md** - Thai quickstart guide
- **AGENT_NOTIFICATION_INTEGRATION.md** - English integration guide
- **TMUX_NOTIFICATION_GUIDE.md** - Tmux bar setup
- **NOTIFICATION_QUICK_REFERENCE.md** - Quick reference card

### Dashboard
- **URL:** http://localhost:3456/office/#overview
- **Press 'n'** - Open notification panel
- **Real-time** - WebSocket updates (8ms latency)

---

## 🎉 Success Metrics

✅ Project plans can be announced to all agents
✅ Task progress can be tracked in real-time
✅ Consultations can be requested easily
✅ Milestones can be celebrated
✅ Planning patterns can be captured

---

**📊 Plan-Mgr is now fully integrated with the Notification System!**

Start sending project updates and track planning progress in real-time!
