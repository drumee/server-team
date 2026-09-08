// service/private/nudgelab.js
//
// Nudge Lab — tester control panel for the upgrade-nudge popups
// (#/devel/nudge on the UI side). Lets a signed-in tester put their OWN
// org/account into any popup scenario with one click instead of hand-run
// SQL: fake storage percentage, seat-cap squeeze, workspace age, plan flip,
// a fresh daily-cap day, reset, full cleanup.
//
// Safety model:
//   * hard-gated by `nudge_lab` in myDrumee.json — off everywhere but test
//     boxes; when off both services answer { enabled: 0 } and write nothing;
//   * every statement keys on the caller's own org id / uid — there is no
//     input that can point it at another tenant;
//   * fixtures the lab creates are tagged (membership ids `nudgelab-…`,
//     quota rows source='nudgelab') so cleanup removes exactly what the lab
//     added; the original workspace ctime is remembered in the block's own
//     `$.nudge_lab.ctime0` before the first age fake and restored from it.
const { Entity } = require('@drumee/server-core');

const SEAT_UNLIMITED = 100000;

function firstRow(r) {
  return Array.isArray(r) ? r[0] : r;
}

class __private_nudgelab extends Entity {
  _enabled() {
    return !!(global.myDrumee && global.myDrumee.nudge_lab);
  }

  /** The caller's scope: their org (domain > 1) or their own account. */
  async _scope() {
    const dom = ~~this.user.domain_id();
    if (dom > 1) {
      const org = firstRow(await this.yp.await_query(
        `SELECT o.id, o.metadata, e.ctime FROM organisation o
           LEFT JOIN entity e ON e.id = o.id WHERE o.domain_id = ? LIMIT 1`, dom
      ));
      if (org && org.id) return { kind: 'org', dom, id: org.id, meta: org.metadata, ctime: Number(org.ctime) || 0 };
    }
    const me = firstRow(await this.yp.await_query(
      `SELECT d.profile, e.ctime FROM drumate d LEFT JOIN entity e ON e.id = d.id
        WHERE d.id = ? LIMIT 1`, this.uid
    ));
    return { kind: 'personal', dom, id: this.uid, meta: me && me.profile, ctime: Number(me && me.ctime) || 0 };
  }

  async _limits(scope) {
    let raw = await this.yp.await_func('get_quota', scope.kind === 'org' ? await this._orgOwner(scope) : this.uid);
    if (typeof raw === 'string') { try { raw = JSON.parse(raw); } catch (e) { raw = null; } }
    const q = raw && typeof raw === 'object' ? raw : {};
    return {
      plan: String(q.plan || 'free').toLowerCase(),
      disk: Number(q.disk || q.storage) || 0,
      seat: q.seat == null ? null : Number(q.seat),
    };
  }

  async _orgOwner(scope) {
    const row = firstRow(await this.yp.await_query(
      `SELECT owner_id FROM organisation WHERE id = ? LIMIT 1`, scope.id
    ));
    return (row && row.owner_id) || this.uid;
  }

  async _numbers(scope, limits) {
    let diskUsed = 0, seatsUsed = 0;
    if (scope.kind === 'org') {
      const u = firstRow(await this.yp.await_query(
        `SELECT GREATEST(IFNULL(actual_usage,0), IFNULL(cached_usage,0)) AS used
           FROM quota_usage WHERE domain_id = ?`, scope.dom
      ));
      diskUsed = Number(u && u.used) || 0;
      try {
        const s = firstRow(await this.yp.await_proc('member_list_stats', scope.id));
        seatsUsed = Number((s && s.total_members) || 0) + Number((s && s.pending_invites) || 0);
      } catch (e) { /* 0 */ }
    } else {
      try { diskUsed = Number(await this.yp.await_func('disk_usage', this.uid)) || 0; } catch (e) { /* 0 */ }
      try {
        const s = firstRow(await this.yp.await_proc('drumate_seat_usage', this.uid));
        seatsUsed = Number((s && s.total_members) || 0) + Number((s && s.pending_invites) || 0);
      } catch (e) { /* 0 */ }
    }
    return { diskUsed, seatsUsed };
  }

  _block(scope) {
    try {
      const m = typeof scope.meta === 'string' ? JSON.parse(scope.meta) : scope.meta;
      return (m && m.upgrade_nudge) || null;
    } catch (e) { return null; }
  }

  async _statePayload() {
    const scope = await this._scope();
    const limits = await this._limits(scope);
    const { diskUsed, seatsUsed } = await this._numbers(scope, limits);
    const nowSec = Math.floor(Date.now() / 1000);
    return {
      enabled: 1,
      scope: scope.kind,
      id: scope.id,
      uid: this.uid,
      plan: limits.plan,
      disk_used: diskUsed,
      disk_limit: limits.disk,
      disk_pct: limits.disk > 0 ? Math.round((1000 * diskUsed) / limits.disk) / 10 : 0,
      seats_used: seatsUsed,
      seat_limit: limits.seat == null || limits.seat >= SEAT_UNLIMITED ? 0 : Number(limits.seat),
      age_days: scope.ctime ? Math.floor((nowSec - scope.ctime) / 86400) : 0,
      block: this._block(scope),
    };
  }

  async state() {
    if (!this._enabled()) return this.output.data({ enabled: 0 });
    this.output.data(await this._statePayload());
  }

  // ── scenario helpers (all scoped to the caller) ───────────────────────────

  async _setStorage(scope, limits, ratio) {
    const size = Math.round(limits.disk * ratio);
    await this.yp.await_query(
      `INSERT INTO disk_usage (hub_id, size) VALUES (?, ?)
         ON DUPLICATE KEY UPDATE size = VALUES(size)`, scope.id, size
    );
    if (scope.kind === 'org') {
      try { await this.yp.await_proc('recalculate_domain_usage', scope.dom); } catch (e) { /* lazy */ }
    }
  }

  async _setOrgSeatCap(scope, cap) {
    await this.yp.await_query(
      `UPDATE quota SET quota = JSON_SET(quota, '$.seat', CAST(? AS INTEGER))
        WHERE domain_id = ? AND payer_id = ?`, ~~cap, scope.dom, scope.id
    );
  }

  /** Personal seats: lab-tagged fake membership rows on the caller's own hub. */
  async _setPersonalMembers(count) {
    await this.yp.await_query(
      `DELETE FROM membership WHERE id LIKE CONCAT('nudgelab-', ?, '-%')`, this.uid
    );
    for (let i = 1; i <= count; i++) {
      await this.yp.await_query(
        `INSERT IGNORE INTO membership
           (id, user_id, drumate_id, privilege, hub_id, area, username, add_time, update_time)
         VALUES (CONCAT('nudgelab-', ?, '-', ?), ?, CONCAT('nudgelabfake', LPAD(?, 4, '0')),
                 3, ?, 'private', CONCAT('nudgelab', ?), UNIX_TIMESTAMP(), UNIX_TIMESTAMP())`,
        this.uid, i, this.uid, i, this.uid, i
      );
    }
  }

  /**
   * Fake the workspace/account age. The ORIGINAL ctime is remembered once in
   * the lab's own corner of the same JSON home, so age_reset puts back the
   * truth no matter how many fakes ran in between.
   */
  async _setAge(scope, days) {
    const table = scope.kind === 'org' ? 'organisation' : 'drumate';
    const col = scope.kind === 'org' ? 'metadata' : 'profile';
    const keyCol = 'id';
    await this.yp.await_query(
      `UPDATE ${table} SET ${col} = JSON_SET(
         IF(${col} IS NULL OR ${col} = '' OR NOT JSON_VALID(${col}), '{}', ${col}),
         '$.nudge_lab', JSON_OBJECT('ctime0',
           CAST(COALESCE(JSON_VALUE(${col}, '$.nudge_lab.ctime0'),
                         (SELECT ctime FROM entity WHERE id = ?)) AS INTEGER)))
        WHERE ${keyCol} = ?`, scope.id, scope.id
    );
    if (days == null) {
      // restore
      await this.yp.await_query(
        `UPDATE entity e
           JOIN ${table} t ON t.${keyCol} = ?
            SET e.ctime = CAST(JSON_VALUE(t.${col}, '$.nudge_lab.ctime0') AS INTEGER)
          WHERE e.id = ? AND JSON_VALUE(t.${col}, '$.nudge_lab.ctime0') IS NOT NULL`,
        scope.id, scope.id
      );
    } else {
      await this.yp.await_query(
        `UPDATE entity SET ctime = UNIX_TIMESTAMP() - ? WHERE id = ?`,
        ~~days * 86400, scope.id
      );
    }
  }

  async _reset(scope) {
    if (scope.kind === 'org') await this.yp.await_proc('org_upgrade_nudge_reset', scope.id);
    else await this.yp.await_proc('drumate_upgrade_nudge_reset', this.uid);
  }

  async _newDay(scope) {
    const table = scope.kind === 'org' ? 'organisation' : 'drumate';
    const col = scope.kind === 'org' ? 'metadata' : 'profile';
    await this.yp.await_query(
      `UPDATE ${table} SET ${col} = JSON_SET(${col},
         CONCAT('$.upgrade_nudge.last_shown.', ?), '2000-01-01')
        WHERE id = ? AND JSON_VALUE(${col}, '$.upgrade_nudge.plan') IS NOT NULL`,
      this.uid, scope.id
    );
  }

  async _planUp(scope, limits) {
    if (scope.kind === 'org') {
      await this.yp.await_query(
        `UPDATE quota SET plan = 'business' WHERE domain_id = ? AND payer_id = ?`,
        scope.dom, scope.id
      );
    } else {
      // Free → Pro via a lab-tagged quota row (mirrors a real pro entitlement).
      await this.yp.await_query(
        `INSERT INTO quota (domain_id, payer_id, plan, quota, ctime, mtime, source)
         SELECT 1, ?, 'pro',
                '{"plan": "pro", "disk": 50000000000, "desk_disk": 50000000000, "hub_disk": 50000000000, "seat": 3, "organization": 0, "history_length": 7, "private_hub": 1, "share_hub": 1, "public_hub": 0, "task_views": "*", "meeting_minutes": 0}',
                UNIX_TIMESTAMP(), UNIX_TIMESTAMP(), 'nudgelab'
          WHERE NOT EXISTS (SELECT 1 FROM quota WHERE payer_id = ? AND source = 'nudgelab')`,
        this.uid, this.uid
      );
    }
  }

  async _planRestore(scope) {
    if (scope.kind === 'org') {
      await this.yp.await_query(
        `UPDATE quota SET plan = 'team' WHERE domain_id = ? AND payer_id = ?`,
        scope.dom, scope.id
      );
    } else {
      await this.yp.await_query(
        `DELETE FROM quota WHERE payer_id = ? AND source = 'nudgelab'`, this.uid
      );
    }
  }

  async scenario() {
    if (!this._enabled()) return this.output.data({ enabled: 0 });
    const name = String(this.input.need('name') || '');
    const scope = await this._scope();
    const limits = await this._limits(scope);

    switch (name) {
      case 'storage_70': await this._setStorage(scope, limits, 0.75); break;
      case 'storage_80': await this._setStorage(scope, limits, 0.85); break;
      case 'storage_90': await this._setStorage(scope, limits, 0.95); break;
      case 'storage_low': await this._setStorage(scope, limits, 0); break;

      case 'seats_70':
        if (scope.kind === 'org') {
          const { seatsUsed } = await this._numbers(scope, limits);
          // smallest cap that lands in [70%, 90%) without going over 100%
          await this._setOrgSeatCap(scope, Math.max(seatsUsed, Math.ceil(seatsUsed / 0.89)));
        } else {
          // personal cap is the plan's 3 — 70–89% has no integer point; use 90.
          await this._setPersonalMembers(3);
        }
        break;
      case 'seats_90':
        if (scope.kind === 'org') {
          const { seatsUsed } = await this._numbers(scope, limits);
          await this._setOrgSeatCap(scope, Math.max(1, seatsUsed)); // 100%, never over
        } else {
          await this._setPersonalMembers(3);
        }
        break;
      case 'seats_off':
        if (scope.kind === 'org') await this._setOrgSeatCap(scope, 10);
        else await this._setPersonalMembers(0);
        break;

      case 'age_14d': await this._setAge(scope, 20); break;
      case 'age_30d': await this._setAge(scope, 35); break;
      case 'age_reset': await this._setAge(scope, null); break;

      case 'plan_up': await this._planUp(scope, limits); break;
      case 'plan_restore': await this._planRestore(scope); break;

      case 'new_day': await this._newDay(scope); break;
      case 'reset': await this._reset(scope); break;

      case 'cleanup':
        await this._setStorage(scope, limits, 0);
        if (scope.kind === 'org') await this._setOrgSeatCap(scope, 10);
        else await this._setPersonalMembers(0);
        await this._setAge(scope, null);
        await this._planRestore(scope);
        await this._reset(scope);
        break;

      default:
        return this.output.data({ enabled: 1, error: 'UNKNOWN_SCENARIO', name });
    }

    // Most scenarios only make sense on a clean slate for the next reload —
    // reset is deliberately NOT implicit though: daily-cap and once-per-
    // threshold cases need the history kept. The lab UI pairs buttons with
    // an explicit Reset instead.
    this.output.data(await this._statePayload());
  }
}

module.exports = __private_nudgelab;
