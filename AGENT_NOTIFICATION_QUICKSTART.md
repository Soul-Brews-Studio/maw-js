# 🔔 ให้ทุก Agent ใช้ Notification System ได้เลย!

## 🚀 3 วิธีในการส่ง Notification

### 1️⃣ Shell Script (ง่ายที่สุด - ใช้ได้เลย!)

```bash
# เข้าไปใน maw-js directory
cd /Users/jodunk/ghq/github.com/Soul-Brews-Studio/maw-js

# ส่ง notification
./scripts/notify.sh "หัวข้อ" "ข้อความ" "channel" "type"

# ตัวอย่าง
./scripts/notify.sh "เริ่มวิเคราะห์" "วิเคราะห์ BTC/USDT" "mqtt" "task_started"

# พร้อม metadata
./scripts/notify.sh "Task Created" "สร้าง task สำเร็จ" "mqtt" "task_created" '{
  "agent": "trade-lead",
  "task_id": "123"
}'
```

### 2️⃣ TypeScript/JavaScript

```typescript
// Import notification client
import { notify, notifyTaskCreated, notifyTaskCompleted } from './src/notification-client';

// ส่ง notification แบบง่าย
await notify({
  channel: 'mqtt',
  type: 'info',
  title: '📋 หัวข้อ',
  message: 'ข้อความ'
});

// แบบมี metadata
await notify({
  channel: 'threads',
  type: 'consultation',
  title: '💬 ต้องการคำปรึกสอ',
  message: 'ควรใช้ strategy ไหนดี?',
  metadata: {
    agent: 'trade-lead',
    target: 'scudd'
  }
});

// แบบใช้ helper function
await notifyTaskCreated('task-123', 'วิเคราะห์ตลาดหุ้น', {
  agent: 'trade-lead',
  pair: 'BTC/USDT'
});
```

### 3️⃣ HTTP API (สำหรับ Agent ภาษาอื่น)

```bash
curl -X POST http://localhost:3456/api/notifications/notify \
  -H "Content-Type: application/json" \
  -d '{
    "channel": "mqtt",
    "type": "task_started",
    "title": "เริ่มงาน",
    "message": "เริ่มวิเคราะห์ข้อมูล",
    "metadata": {
      "agent": "YOUR_AGENT"
    }
  }'
```

## 📋 สถานการณ์การใช้งานจริง

### Trade-Lead Agent

```bash
# Task สร้างเสร็จ
./scripts/notify.sh \
  "Task Created" \
  "สร้าง task วิเคราะห์ BTC/USDT" \
  "mqtt" \
  "task_created" \
  '{"agent":"trade-lead","pair":"BTC/USDT","timeframe":"4h"}'

# ขอคำปรึกสอ
./scripts/notify.sh \
  "💬 ต้องการคำปรึกสอ" \
  "ควรใช้ grid strategy หรือ DCA ดี?" \
  "threads" \
  "consultation" \
  '{"agent":"trade-lead","target":"scudd"}'

# เมื่อวิเคราะห์เสร็จ
./scripts/notify.sh \
  "✅ วิเคราะห์เสร็จ" \
  "พบ 3 จุด entry ที่น่าสนใจ" \
  "mqtt" \
  "task_completed" \
  '{"agent":"trade-lead","signals":3,"confidence":0.85}'
```

### Asset-Lead Agent

```bash
# Portfolio health check
./scripts/notify.sh \
  "📊 Portfolio Check" \
  "ตรวจสอบสุขภาพ portfolio" \
  "mqtt" \
  "health_check" \
  '{"agent":"asset-lead","total_assets":5}'

# แจ้งเตือน risk
./scripts/notify.sh \
  "🚨 Risk Alert" \
  "BTC เกิน risk limit แล้ว!" \
  "mqtt" \
  "urgent_alert" \
  '{"agent":"asset-lead","asset":"BTC","risk_level":"high"}'
```

### Plan-Mgr Agent

```bash
# สร้าง plan ใหม่
./scripts/notify.sh \
  "📋 Project Plan Created" \
  "สร้าง plan สำหรับโปรเจกต์ใหม่" \
  "mqtt" \
  "plan_created" \
  '{"agent":"plan-mgr","project":"trading-bot","tasks":15}'

# Task เสร็จตาม plan
./scripts/notify.sh \
  "✅ Plan Task Completed" \
  "ทำ task ตาม plan เสร็จแล้ว" \
  "mqtt" \
  "plan_task_completed" \
  '{"agent":"plan-mgr","project":"trading-bot","task_id":5}'
```

### Scudd Agent

```bash
# เริ่มวิจัย
./scripts/notify.sh \
  "🔬 Research Started" \
  "วิจัยกลยุทธ์ grid trading ใหม่" \
  "threads" \
  "research_started" \
  '{"agent":"scudd","strategy":"grid-trading","focus":["backtest","optimization"]}'

# ขอ consultation
./scripts/notify.sh \
  "💭 ขอความคิดเห็น" \
  "กลยุทธ์นี้ suitable สำหรับ bear market ไหม?" \
  "threads" \
  "consultation" \
  '{"agent":"scudd","target":"trade-lead","urgency":"medium"}'
```

### Frontend-Lead Agent

```bash
# Feature เสร็จ
./scripts/notify.sh \
  "✅ Feature Built" \
  "สร้าง feature dashboard ใหม่เสร็จ" \
  "mqtt" \
  "feature_completed" \
  '{"agent":"frontend-lead","feature":"dashboard","warnings":0}'

# Build warning
./scripts/notify.sh \
  "⚠️ Build Warnings" \
  "มี 3 warnings ตอน build" \
  "mqtt" \
  "build_warning" \
  '{"agent":"frontend-lead","warnings":3,"feature":"dashboard"}'
```

### Thump Agent

```bash
# ส่งต่อ message
./scripts/notify.sh \
  "📨 Message Routed" \
  "ส่งต่อ message จาก trade-lead → scudd" \
  "mqtt" \
  "message_routed" \
  '{"agent":"thump","from":"trade-lead","to":"scudd","confidence":0.95}'

# Routing error
./scripts/notify.sh \
  "❌ Routing Failed" \
  "ไม่สามารถ route message ได้" \
  "mqtt" \
  "routing_error" \
  '{"agent":"thump","error":"unknown_target","from":"unknown"}'
```

## 🎯 Channel Guidelines

### 📡 MQTT Channel
ใช้สำหรับ:
- ✅ Task updates (สร้าง, ดำเนินการ, เสร็จ)
- ✅ Urgent alerts (เรื่องด่วน)
- ✅ Errors & warnings
- ✅ Status updates

ตัวอย่าง: `task_created`, `task_completed`, `urgent_alert`, `error`, `warning`

### 💬 Threads Channel
ใช้สำหรับ:
- 💬 คำปรึกสอ / ขอคำแนะนำ
- 💭 ขอความเห็น / opinion
- 🤔 อภิปรายกลยุทธ์
- 📚 แชร์ knowledge

ตัวอย่าง: `consultation`, `opinion_request`, `discussion`, `knowledge_share`

### 🧠 Memory Channel
ใช้สำหรับ:
- 🧠 Sync status (Thread → Memory Hub)
- 📖 Learning captured
- 💡 Pattern discovered
- 📝 Retrospective created

ตัวอย่าง: `thread_synced`, `learning_created`, `pattern_discovered`

## 📊 Notification Types

### Task-Based
- `task_created` - Task ถูกสร้าง
- `task_started` - Task เริ่มดำเนินการ
- `task_completed` - Task เสร็จสมบูรณ์
- `task_failed` - Task ล้มเหลว
- `task_blocked` - Task ถูก block

### Consultation-Based
- `consultation` - ขอคำปรึกสอ
- `opinion_request` - ขอความเห็น
- `discussion` - เปิดอภิปราย
- `advice_request` - ขอคำแนะนำ

### Status-Based
- `info` - ข้อมูลทั่วไป
- `warning` - คำเตือน
- `error` - ข้อผิดพลาด
- `urgent` - เรื่องด่วน
- `success` - สำเร็จ

## 🧪 Testing

```bash
# Test ว่า notification system ทำงานไหม
curl -s http://localhost:3456/api/notifications | jq '.[] | {title, channel, type}' | head -5

# ดู statistics
curl -s http://localhost:3456/api/notifications/stats | jq '.'

# Test ส่ง notification จาก shell
./scripts/notify.sh "🧪 Test" "ทดสอบระบบ" "mqtt" "test"
```

## 📱 Dashboard

เข้าไปดู notifications ได้ที่:
- **URL**: http://localhost:3456/office/#overview
- **Keyboard**: กด **'n'** key
- **Button**: คลิก **🔔** ที่ status bar

## 💡 Best Practices

1. **ใช้ Title สั้น กระชับ** - ไม่เกิน 200 ตัวอักษร
2. **Message ชัดเจน** - ไม่เกิน 1000 ตัวอักษร
3. **เลือก Channel ให้ถูกต้อง** - MQTT=action, Threads=discussion, Memory=knowledge
4. **ใส่ Metadata** - ช่วย filter และ analyze ง่ายขึ้น
5. **ห้าม Spam** - ส่งเฉพาะ notifications ที่สำคัญเท่านั้น

## 🚀 เริ่มใช้งานได้เลย!

ตอนนี้ทุก Agent สามารถส่ง notifications ได้ทันที:

```bash
# เข้าไปใน maw-js directory
cd /Users/jodunk/ghq/github.com/Soul-Brews-Studio/maw-js

# ส่ง notification แรกแรกของคุณ!
./scripts/notify.sh "Hello World" "Agent X เริ่มทำงานแล้ว!" "mqtt" "info"
```

---

**🎉 ทุก Agent พร้อมส่ง notifications แล้ว!**
