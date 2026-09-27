---
phase: 1
title: "Admit conference.invite + policy + tests + merge vào test"
status: pending
priority: P1
effort: "1d"
dependencies: []
---

# Phase 1: Admit conference.invite vào mobile-push

## Overview

Cho `conference.invite` đi vào pipeline `admit → mobilePushQueue → mobilePushWorker → FCM`
với TTL ngắn và nội dung ring.

## Requirements

- `service/lib/mobile-push.js`:
  - `ALLOWED_EVENTS` (:7-13) += `'conference.invite'`.
  - **`normalizeEvent` (:35-47) dựng object cố định và bỏ key lạ** → thêm `room_id` (validate bằng `ID`, :15) và `room_type` (chuỗi ngắn), nếu không `data.room_id` luôn rỗng. Test: `room_id` sống tới job `deliver` (`mobilePushWorker.js:119,124-131`).
- `service/conference.js` `invite()` (`room_id` là input tuỳ chọn :567 nhưng cả web lẫn mobile luôn gửi):
  - Admit `{type:'conference.invite', actor_id: this.uid, hub_id, key_id: room_id, room_id, room_type: (this.input.get(Attr.metadata)||{}).type, recipient_uids:[guest_id], expires_at: Math.floor(Date.now()/1000) + 60}` — **`expires_at` là epoch giây** (`mobile-push.js:44`), không phải ms.
  - Ở ba nhánh: `data.offline` (~589), `clients` rỗng (~609), live (~638). **Không** push ở nhánh `cross_call` (:572-583). Chỉ admit khi có `room_id`.
  - Fire-and-forget: lỗi admit chỉ log, response `invite` không đổi.
  - Ghi nhận: nhánh live cấp quyền rendez-vous 24 h cho guest (`conference_invite.sql:35-54`), nhánh offline không cấp → người được mời từ push chỉ Join được nếu là member hub (mobile chỉ mời member hub → chấp nhận).
- `service/lib/mobile-push-recipients.js`: `conference.invite` dùng shape `hub_id` + `recipient_uids` (không vào `BROADCAST_EVENTS`). Recipient tường minh hiện bị giao với ≤100 member đầu (trang 45, :2-3,29-46,58-63) → với event không broadcast, kiểm từng uid bằng `hubRecipientAllowed` sẵn có thay vì giao phân trang (không SQL mới).
- `service/lib/mobile-push-content.js`: `EVENT_BODY['conference.invite'] = () => 'Is calling you'` (giá trị là **hàm**, :50-57,121 — chuỗi sẽ rơi về `GENERIC_NOTIFICATION`); thêm vào `WORKSPACE_SUBTITLED`; title = `push_actor_name`.
- `service/lib/mobile-push-policy.js` `buildFcmMessage` + `offline/workers/mobilePushWorker.js` `sendFcm`:
  - `data` += `room_id`, `actor_id`, `room_type`, **`expires_at`** (epoch giây, để app bỏ ring cũ), tất cả `String(...)`.
  - **`sendFcm` kiểm hết hạn trước khi gọi FCM**: `if (Number(delivery.expires_at) <= nowSec) return {expired:true}` — retry backoff 60 s × 4 (`mobilePushQueue.js:33-36`) có thể chạy sau hạn; `ttl` âm → `INVALID_ARGUMENT` → `permanentFcmError` → `device_registration_v2_invalidate` (`mobilePushWorker.js:166-173`) **xoá đăng ký push của máy cho mọi loại push**.
  - Android `ttl = max(0, expires_at − nowSec) + 's'` (thay hard-code `'3600s'` :41); event không set `expires_at` giữ mặc định.
  - Gộp banner: Android **`android.notification.tag = room_id`** (thay banner đang hiện; `collapse_key` chỉ gộp tin xếp hàng khi offline — tuỳ chọn); iOS header `apns-collapse-id = room_id` (≤64 B).
  - Giữ `apns-push-type: 'alert'` (data-only không đánh thức app terminated).
- TTL giới hạn **giao tin**, không thu hồi banner đã hiện; không có push huỷ khi caller cúp/callee trả lời trên web — chấp nhận ở v1 (app chặn tap cũ bằng `expires_at`).
- Không raw SQL, không stored procedure mới.

## Related Code Files

- Modify: `service/conference.js`, `service/lib/mobile-push.js`, `service/lib/mobile-push-content.js`, `service/lib/mobile-push-policy.js`
- Modify thêm: `offline/workers/mobilePushWorker.js` (`sendFcm` expiry guard), `service/lib/mobile-push-recipients.js` (explicit recipient check)
- Tests: mở rộng `test/mobile-push-*.test.js`: admission (`room_id`/`room_type` sống qua normalize, `expires_at` giây), policy (ttl từ expires_at, `notification.tag`, `apns-collapse-id`, data string), worker (delivery hết hạn → không gọi FCM, không invalidate), content (title/subtitle/body), recipients (invitee ngoài 100 member đầu vẫn nhận)

## Implementation Steps

1. Nhánh `feat/conference-mobile-push` từ `test` mới nhất.
2. Policy + content + whitelist + test (thuần, không cần stage).
3. Admit trong `invite()` ba nhánh; review không đổi response shape `{offline:1}` / payload socket.
4. Chạy các test node; `node -e "require('./service/conference')"` smoke load.
5. Commit conventional không AI trailer; **merge vào `test`** (Aaron 2026-09-24), push `origin/test`.

## Success Criteria

- [ ] Test standalone xanh (admission / policy / content).
- [ ] Response `conference.invite` không đổi (diff chỉ thêm admit).
- [ ] Đã merge vào `test` và push; message commit nêu hành vi, không nêu plan ID.

## Risk Assessment

- Người bị ring nhiều lần (spam invite): collapse theo `room_id` + TTL 60 s giới hạn; rate-limit ngoài scope.
- `occurred_at` khác nhau giữa các lần → `event_id` khác → không dedupe server: chấp nhận, collapse OS lo phần hiển thị.
