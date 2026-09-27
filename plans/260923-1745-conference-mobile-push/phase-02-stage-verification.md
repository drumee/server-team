---
phase: 2
title: "Deploy stage + verify với app mobile"
status: pending
priority: P1
effort: "0.5d"
dependencies: [1]
---

# Phase 2: Verify trên stage

## Overview

Sync `test` lên stage `aaron` (tìm cách deploy ở bước đầu, ghi vào plan Unresolved 1 / memory nếu Aaron xác nhận), verify end-to-end với drumee-mobile (Android
emulator có Play services nhận FCM thật; iOS simulator không nhận APNs thật →
iOS để lượt máy thật ở bảng evidence roadmap).

## Requirements

- Chỉ tài khoản `temptest1`–`temptest10@drumee.com`; prelive read-only; credentials không echo/log.
- Kịch bản (B = người gọi, A = app mobile trên emulator):
  1. A background → B `conference.invite` → banner OS ≤ 5 s, title = tên B, subtitle "To {workspace}", body "Is calling you".
  2. A terminated (force-stop) → như trên; tap → cold start → tab Meet đúng workspace (+ ring nếu còn cửa sổ — phase 12 mobile).
  3. A foreground → không banner OS thêm; ring socket vẫn hiện một lần.
  4. B ring hai lần liên tiếp → Android thay banner cũ (`notification.tag`), không thành hai.
  5. A offline 90 s rồi online → không banner muộn (không giao sau `expires_at`).
  6. A vừa background < 1 phút (socket còn sống, Android FGS) → ring socket + banner OS; tap banner → không ring lần hai (dedupe `room_id`).
  7. A trả lời trên web → banner trên phone vẫn còn (chấp nhận ở v1); tap sau 60 s → chỉ mở tab Meet.
  8. Không có registration nào bị invalidate trong log sau các kịch bản trên.
- Log `mobilePushWorker` cho event (không in token/registration id).

## Success Criteria

- [ ] 8 kịch bản pass, ghi kết quả + thời gian vào report `plans/reports/`.
- [ ] Không lỗi mới trong log push worker / conference.

## Risk Assessment

- Stage chưa có service account FCM hợp lệ cho bản stage app → push không tới dù code đúng; kiểm `chat.post` push trước làm baseline.
