# Lessons Learned — maw-js

## 2026-04-04: maw-ui Dashboard 404 on port 3456

### Summary
"404 ทุก route บน port 3456" ที่รายงาน ไม่ใช่ปัญหาของ maw-js backend จริงๆ
maw-js backend ทำงานปกติ — /api/* routes ทั้งหมดตอบสนองถูกต้อง

### Root Causes (2 อัน)

1. **maw-ui dev server ไม่ได้ run**: tmux session `maw-ui` ถูก Ctrl+C ไป
   ทำให้ port 5173 ไม่มี listener — Dashboard เปิดไม่ได้
   Fix: `tmux send-keys -t "maw-ui:1" "cd /home/lfz/.../maw-ui && bun dev" Enter`

2. **vite.config.ts proxy hardcode hostname เก่า**: ไฟล์ใน git HEAD มี
   proxy target ชี้ไป `white.local:3456` ซึ่ง resolve ไม่ได้บน WSL machine นี้
   ทำให้ทุก API call fail ด้วย `ENOTFOUND white.local`
   Fix: เปลี่ยน proxy target เป็น `localhost:3456` + เพิ่ม allowedHosts

### Fix Applied
- `maw-ui/vite.config.ts`:
  - allowedHosts เพิ่ม `"localhost"` และ `"127.0.0.1"`
  - proxy target เปลี่ยนจาก `white.local:3456` เป็น `localhost:3456`

### Architecture Note
- maw-js port 3456 = pure backend API (Hono) — ไม่มี route `/` — นี่คือ by design ตั้งแต่ commit 923b1ca
- maw-ui port 5173 = frontend (Vite dev) — proxy /api/* ไปยัง 3456
- Dashboard URL ที่ถูกต้องคือ http://localhost:5173/ ไม่ใช่ http://localhost:3456/

### Prevention
- ถ้า Dashboard เข้าไม่ได้ให้ตรวจ port 5173 ก่อน ไม่ใช่ 3456
- `ss -tlnp | grep 5173` เช็คว่า maw-ui run อยู่หรือเปล่า
- vite.config.ts ห้าม hardcode hostname ของ machine เฉพาะ ควรใช้ localhost เสมอ
