---
title: "Push OS cho cuộc gọi đến (conference.invite) tới app mobile"
description: "Cho conference.invite đi qua pipeline mobile-push (FCM/APNs) để phone có app background/terminated vẫn nhận banner 'X is calling you'; TTL ngắn, collapse theo room; không đổi stored procedure."
status: pending
priority: P1
effort: "1d + verify"
branch: "feat/conference-mobile-push → merge into test"
tags: [mobile-push, conference, fcm, apns, drumee-mobile]
created: 2026-09-24
blockedBy: []
blocks: ["drumee-mobile:260920-0842-drumee-mobile-meeting-jitsi (phase 12)"]
research: "../../../drumee-mobile/plans/260920-0842-drumee-mobile-meeting-jitsi/reports/researcher-260924-conference-push.md"
---

# Push OS cho cuộc gọi đến

## Overview

Hôm nay `conference.invite` / `conference.start` chỉ đi qua socket live
(`RedisStore.sendData`); `service/conference.js` không gọi `admitMobilePush`.
Khi callee không có socket, stored proc `conference_invite` trả `{offline:1}`
và `invite()` (`conference.js:~589`, `~609`) dừng — không push, không gì cả.
Test Android emulator 2026-09-24 xác nhận: app background → ring mất hẳn.

Pipeline mobile-push đã gửi `notification` block native
(`mobile-push-policy.js:23-63`) nên chỉ cần **cho event vào**: whitelist, nội
dung, data keys, TTL ngắn, và gọi admit ở `invite()`. Không cần đổi schemas
(mọi lookup `hub_members_for_mobile_push`, `push_registration_*`,
`push_actor_name`, `push_workspace_name` đã có).

Yêu cầu từ Aaron 2026-09-24 ("lên kế hoạch cho server-team"); app phía mobile
là phase 12 của plan `drumee-mobile/plans/260920-0842-drumee-mobile-meeting-jitsi`.

## Goals

| # | Goal | Priority |
|---|------|----------|
| 1 | Mỗi `conference.invite` thành công hoặc `{offline:1}` → admit push `conference.invite` cho `guest_id` | P1 |
| 2 | Push ring **không được giao** sau 60 s (Android `ttl` + APNs expiration, worker bỏ delivery hết hạn — không invalidate registration), gộp banner theo `room_id` (`notification.tag` / `apns-collapse-id`) | P1 |
| 3 | Banner "{Caller} · To {workspace} · Is calling you"; data có `room_id`, `actor_id`, `room_type`, `expires_at` (qua `normalizeEvent`) | P1 |
| 4 | Test standalone cho admission / policy / content | P1 |

## Non-goals

- VoIP/PushKit, CallKit, Android full-screen intent (ring khi máy ngủ) — ngoài scope (Aaron 2026-09-24).
- `conference.start` push — **không làm** (Aaron 2026-09-24).
- Opt-out / mute setting cho push (pipeline chưa có cho event nào).
- Sửa vi phạm raw-SQL sẵn có ở `mobile-push-authorization.js:37-49` (ghi nhận, không mở rộng).

## Phases

| # | Phase | Status |
|---|-------|--------|
| 1 | [Admit conference.invite + policy + tests + merge vào test](./phase-01-admit-conference-invite.md) | Pending |
| 2 | [Deploy stage + verify với app mobile](./phase-02-stage-verification.md) | Pending |

## Success Criteria

- [ ] temptest B `conference.invite` temptest A khi app A background **và** terminated → A thấy banner OS trong ≤ 5 s; tap mở app vào tab Meet đúng workspace.
- [ ] Push không được giao sau 60 s (tắt mạng máy A 90 s rồi bật → không banner); không registration nào bị invalidate.
- [ ] Ring lặp cùng room chỉ còn một banner.
- [ ] Test node standalone xanh; không raw SQL mới; merge vào `test`, stage `aaron` chạy bản mới.

## Red Team Review

2026-09-24: phát hiện server trong [`drumee-mobile/.../reports/red-team-260924-follow-ups.md`](../../../drumee-mobile/plans/260920-0842-drumee-mobile-meeting-jitsi/reports/red-team-260924-follow-ups.md) (C1, C2, H1, H2, M4–M7, M11, L6, L7) — tất cả đã sửa vào phase 1–2.

## Validation Log

### Session 1 — 2026-09-24 (Aaron)

| # | Câu hỏi | Quyết định |
|---|---|---|
| 1 | Push `conference.start` | **Không push** — chỉ người được mời đích danh (`conference.invite`); meeting có lịch dùng `room.reminder` sẵn có |
| 2 | Ai làm, nhánh nào | **Làm luôn, merge thẳng vào `test`** (nhánh feature local → merge `test`, không chờ PR), **sync lên stage `aaron`** để test |
| 3 | Tên người gọi trong `data` | Không thêm (title banner đã có tên; app tra từ `actor_id`) — mặc định, không phải PII mới |

## Unresolved questions

1. Cách sync code server-team lên stage `aaron` (deploy script / restart service) — tìm ở đầu phase 2, ghi lại cho lần sau.
