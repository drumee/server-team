# Drumee Team Server
This package provides Drumee Team Services API. It is intended for developers purpose. 
If you just need to use Drumee as a standalone Collaborative system, head to [this documentation](https://github.com/drumee/documentation/blob/main/Production-install.md)
At the moment the package contains following components. There are plans to split into smaller part. Contributors are gladly welcome to help.

## Drumee Core Features
- Identity managemen (yellow page)
- Filesystem Management
## File sharing
- Open or closed groups
## Video conferencing 
- Jitsi embodied
## Instant message
- Chat

# How to install on your local host 
- Install Drumee Docker Image from this [documentation] (https://github.com/drumee/documentation/wiki/Developer-Corner)
- 
```console
git clone https://github.com/drumee/server-team.git
cd server-team
npm i
```

## Mobile push worker

Mobile push is intentionally a separate long-running worker so Firebase or
queue failures cannot change the REST, WebSocket, or Activity paths. Its
logical process name is `mobile-push`; the executable entry is
[`npm run worker:mobile-push`](package.json), which runs
[`offline/workers/mobilePushWorker.js`](offline/workers/mobilePushWorker.js).
Queue ownership and health counts live in
[`offline/queues/mobilePushQueue.js`](offline/queues/mobilePushQueue.js), while
payload, authorization, and retry policy live under
[`service/lib/mobile-push*.js`](service/lib/).

The notification banner names who acted and which workspace they acted in, and
stops there: no message body, filename, task title, or email address ever
enters the payload, because everything in it reaches Google and Apple
infrastructure and shows on a locked screen. Wording and the per-event-type
strings live in
[`service/lib/mobile-push-content.js`](service/lib/mobile-push-content.js),
which reads names through the `push_actor_name` and `push_workspace_name`
procedures — `push_actor_name` composes the display name from the given and
family name alone, so the rule that an account email never reaches a push
provider is enforced in the database rather than in the worker;
extend that module rather than passing content in from a producer, since
admission deliberately rejects any event field that is not ID-shaped. Names are
resolved at delivery time and memoized per worker process, so nothing but
identifiers is ever written to Redis. A name that cannot be resolved — a
deleted actor, a nameless account, an unavailable database — degrades to the
generic `Drumee` / `You have new activity` banner and still delivers; push is
advisory and the authenticated Activity feed stays the source of truth.

Hub recipient enumeration uses the dedicated
`hub_members_for_mobile_push(page, range)` procedure. The database clamps pages
to 45 rows and the worker stops at its configured recipient cap; do not replace
this boundary with `hub_get_members_by_type`, which materializes the complete
membership set before returning.

The mobile Notification surface uses `activity.get_feed` for server-backed
full/unread history. Database-page rows are marked as the authoritative page
source so clients do not treat page-one merged rollups as pagination capacity.
`activity.mark_all_read` acknowledges without removing history;
`activity.dismiss*` owns explicit removal and the full-feed path fails closed
when its owning procedure is unavailable. Read chat/teamchat/ticket rollups are
snapshotted before their pointers advance; the snapshot stores opaque identity
and timing only, never message content, email, filenames, payloads, or routes.
Rollup mutations resolve the caller's current canonical feed identity and
reject stale snapshot versions before reaching database procedures. Activity
bookmarks remain inside the authenticated user's database and store only their
opaque hash; executable contracts live in
[`test/activity-mobile-feed-contract.test.js`](test/activity-mobile-feed-contract.test.js).

Before starting the worker, give its process identity Firebase Cloud Messaging
permission through
[Google Application Default Credentials (ADC)](https://cloud.google.com/docs/authentication/application-default-credentials).
Prefer an attached workload identity or Workload Identity Federation; do not
create, commit, or embed a service-account key. For certificate-sourced
federation,
set these process environment variables to approved configuration files outside
the repository:

- `GOOGLE_APPLICATION_CREDENTIALS` — ADC credential-configuration path.
- `GOOGLE_API_CERTIFICATE_CONFIG` — certificate-configuration path when it is
  not installed at ADC's well-known location. The referenced private key must
  remain in the secret-managed runtime boundary.

Set `firebase_project_id` explicitly to `drumee-7ffcc` in Drumee runtime
configuration and grant the worker identity access to that same Firebase
project. Set `mobile_push_queue_generation` explicitly to the deployment's
current monotonic generation; the producer and worker must use the same value.
These keys are read through `sysEnv()` by the worker and queue owners linked
above.

Operate only the named worker and queue from the deployed `server-team`
directory:

- **Start:** configure the ADC identity and both runtime keys, then launch
  `npm run worker:mobile-push` under the process supervisor as
  `<instance>/mobile-push`. Startup is healthy only after the
  `mobile_push_worker_ready` event.
- **Status/health:** check that named process and its structured error events,
  then read queue counts with
  `node -e "(async()=>{const {stats,mobilePushQueue:q}=require('./offline/queues/mobilePushQueue');try{console.log(await stats())}finally{await q.close()}})()"`.
- **Stop:** ask the supervisor to send `SIGTERM` to only that process and wait
  for `mobile_push_worker_stopped`.
- **Pause/resume:** globally pause with
  `node -e "(async()=>{const {mobilePushQueue:q}=require('./offline/queues/mobilePushQueue');try{await q.pause(false)}finally{await q.close()}})()"`;
  resume by replacing `pause(false)` with `resume(false)`.
- **Rollback:** pause the queue, stop the named worker, roll back producer and
  worker code together, and advance `mobile_push_queue_generation` before a
  later restart so stale jobs are fenced. Restore a database backup only for
  proven migration corruption after writers are stopped.

This section is evergreen operating guidance, not proof that an environment is
ready. Keep dated environment results and remaining gates in that deployment's
stateful evidence record.
