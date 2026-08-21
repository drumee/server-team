/**
 * @license
 * Copyright 2024 Thidima SA. All Rights Reserved.
 * Licensed under the GNU AFFERO GENERAL PUBLIC LICENSE, Version 3 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * https://www.gnu.org/licenses/agpl-3.0.html
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 * =============================================================================
 */
const { isEmpty, isArray, difference, map } = require('lodash');
const __public_room = require("../room");
const { Attr, Privilege, Cache, sysEnv, RedisStore, toArray } = require("@drumee/server-essentials")
const { memberCan, CAN_WRITE } = require("../lib/member-capability");

//########################################
class __private_room extends __public_room {


  /**
 * 
 */
  _getShareLink(token) {
    let keysel = this.hub.get(Attr.id);
    const pathname = `?keysel=${keysel}/#/dmz/meeting`;
    let link = `${this.input.homepath()}${pathname}`;
    if (token) link = `${link}/${token}`;
    return link;
  }

  /**
   * 
   * @param {*} recipients 
   * @param {*} node 
   */
  async _commit_invitation(recipients, node, notify = 1) {
    if (isEmpty(recipients)) return;
    const permission = this.input.use(Attr.permission) || Privilege.write;
    const pw = this.input.get(Attr.password);
    const days = this.input.get(Attr.days) || 0;
    const hours = this.input.get(Attr.hours) || 0;
    const expiry = (hours * 1) + (days * 24);

    let hub_id = this.hub.get(Attr.id);
    let nid = node.id;

    if (!isArray(recipients)) {
      recipients = [recipients];
    }
    for (var r of recipients) {
      let g = await this.yp.await_proc('dmz_add_user', r.email, r.name);
      let p = await this.yp.await_proc('dmz_grant_next', hub_id, nid,
        g.id, this.randomString(), pw
      );
      await this.db.await_proc('permission_grant',
        nid, g.id, expiry, permission, 'no_traversal', r.email
      );

      let mail_title = `${Cache.message('_video_meeting_invitation', this.lang).format(this.username)}`;

      let opt = {
        recipient: r.email,
        subject: mail_title,
        template: "butler/external-meeting",
        title: node.title,
        date: node.date,
        message: node.message,
        sender: this.user.get('fullname'),
        headline: node.headline,
        recipient_name: r.name || r.email,
        link: this._getShareLink(p.token),
      }
      if (notify) {
        await this.notify_by_email({ hub_id: node.hub_id, ...opt });
      }
    }
  }

  /**
   * 
   */
  async public_link() {
    const nid = this.input.need(Attr.nid);
    const pw = this.input.get(Attr.password);
    const days = this.input.get(Attr.days) || 0;
    const hours = this.input.get(Attr.hours) || 0;
    const expiry = (hours * 1) + (days * 24);
    const permission = this.input.use(Attr.permission) || Privilege.write;

    let hub_id = this.hub.get(Attr.id);
    let public_id = Cache.getSysConf('public_id');

    let p = await this.yp.await_proc('dmz_grant_next', hub_id, nid,
      public_id, this.randomString(), pw
    );
    await this.db.await_proc('permission_grant',
      nid, public_id, expiry, permission, 'link', ''
    );
    this.debug("AAAA:104", p)
    let link = this._getShareLink(p.token)
    this.output.data({ link });
  }


  /**
   * 
   */
  async book() {
    // Scheduling a meeting is an EDIT-tier action — it creates a `schedule` node
    // in the workspace — so view (privilege 3) and chat (7) must be refused.
    //
    // The ACL cannot do this: acl/room.json declares `src: "write"` but ALSO
    // `fast_check: "user_permission"`, and server-core's acl.js short-circuits on
    // fast_check (check_env returns `{fast_check:1}` before check_source ever
    // runs), so the declared `src` is never evaluated — any member with a
    // non-zero privilege passes. Hence the explicit gate here.
    //
    // This closes the capability on its own: update() and remove() are already
    // creator-only (NOT_MEETING_OWNER), so a member who cannot create a meeting
    // has none of their own to edit or delete.
    if (!(await memberCan(this, CAN_WRITE))) {
      return this.exception.forbiden();
    }
    let lang = this.user.get(Attr.profile).lang || this.input.ua_language();
    let name = this.user.get('fullname');
    const Moment = require('moment');
    Moment.locale(lang);
    let headline = this.user.locale_message('_meeting_scheduled_by_x').format(name);
    let title = this.input.use(Attr.title) || headline;
    let date = this.input.use(Attr.date) || Moment(Moment.now() / 1000, 'X').format('LLLL');
    if (title.length > 100) {
      title = title.slice(0, 100);
    }
    // Agenda/description is whatever the organizer typed — nothing else. It
    // used to default to the '_x_invite_you_meeting' boilerplate, which then
    // showed up prefilled in the scheduler's Description field and could never
    // be cleared (an empty message just re-substituted the boilerplate).
    let message = this.input.use(Attr.message) || '';
    // Canonical meeting time = UNIX-epoch seconds (stime/etime), the source of
    // truth used for calendar range queries (see room_list_scheduled). `date`
    // stays as a human display string for back-compat with player/schedule.
    let stime = this.input.use(Attr.stime, null);
    let etime = this.input.use(Attr.etime, null);
    // Recurrence rule: { freq: 'daily'|'weekly'|'monthly', until?: epoch } or
    // null for a one-off. The calendar expands occurrences client-side.
    let recur = this.input.use('recur', null);

    let args = {
      owner_id: this.uid,
      filename: title,
      pid: this.home_id,
      category: "schedule",
      ext: "schedule",
      mimetype: "application/json",
      filesischeduleze: 0,
      showResults: 1
    };
    let results = { isOutput: 1 };
    let metadata = {
      content: {
        attendees: [], title, message, date, stime, etime, recur,
        created_by: this.uid, room_id: "set-me"
      },
      room_status: 'booked'
    };
    let node = await this.db.await_proc("mfs_create_node", args, metadata, results);
    this.debug(`call mfs_create_node('${JSON.stringify(args)}', '${JSON.stringify(metadata)}')`);
    // Register in the global reminder index (creator only for now — attendees
    // are added by a subsequent update() with flag 'member').
    await this._index_meeting(node && (node.id || node.nid), metadata.content);
    this.output.data(node);
  }

  /**
    * 
    */
  async update() {
    const Moment = require('moment');
    const flag = this.input.need(Attr.flag);
    const nid = this.input.need(Attr.nid);
    let name = this.user.get('fullname');

    let node = await this.db.await_proc('mfs_node_attr', nid);
    let metadata = this.parseJSON(node.metadata);
    let content = this.parseJSON(metadata.content);
    // Owner-only edit: only the creator may modify (legacy meetings without a
    // recorded creator stay editable for backward-compat).
    if (content.created_by && content.created_by !== this.uid) {
      this.exception.user("NOT_MEETING_OWNER");
      return;
    }
    let attendees = content.attendees
    let title = content.title
    let message = content.message
    let date = content.date
    let stime = content.stime
    let etime = content.etime
    let recur = content.recur

    // The start time BEFORE this edit, so a real reschedule can be told apart
    // from a save that left the time alone. The scheduler posts the whole form
    // with flag 'all' on every edit, so comparing is the only way to avoid
    // announcing a "new time" that is the old one.
    const prevStime = Number(stime) || 0;

    if (flag == 'when' || flag == 'all') {
      date = this.input.use(Attr.date) || Moment(Moment.now() / 1000, 'X').format('LLLL');
      // Keep the queryable epochs in lockstep with the display date; only
      // overwrite when the client actually sends them (preserve otherwise).
      let _stime = this.input.use(Attr.stime, null);
      let _etime = this.input.use(Attr.etime, null);
      if (_stime != null) stime = _stime;
      if (_etime != null) etime = _etime;
    }

    // Recurrence is flag-agnostic: update it whenever the client sends `recur`
    // (an object to set, or null to clear); preserve otherwise.
    // `input.use(key, def)` collapses null INTO the default, so `recur: null` —
    // what the scheduler sends when Repeat is switched back to None — read as
    // "not sent" and the old rule was preserved: a series set by mistake kept
    // repeating forever and could not be cleared from the UI. Read the raw value
    // so an explicit null clears and a missing key still preserves.
    const _recur = this.input.get('recur');
    if (_recur !== undefined) recur = _recur || null;

    if (flag == 'title' || flag == 'all') {
      let headline = this.user.locale_message('_meeting_scheduled_by_x').format(name);
      title = this.input.use(Attr.title) || headline;
      if (title.length > 100) {
        title = title.slice(0, 100);
      }
      await this.db.await_proc('mfs_rename', nid, title);
    }

    if (flag == 'agenda' || flag == 'all') {
      // Same as book(): no boilerplate fallback, or clearing the agenda would
      // silently restore it on every save.
      message = this.input.use(Attr.message) || '';
    }
    // Attendees are WORKSPACE MEMBERS, keyed by uid (no email/DMZ invite). We
    // store { uid, name } and notify only the newly-added members in-app.
    let addedUids = [];
    if (flag == 'member' || flag == 'all') {
      let incoming = this.input.use(Attr.attendees, []);
      if (!isArray(incoming)) incoming = incoming ? [incoming] : [];
      const prevUids = (isArray(attendees) ? attendees : [])
        .map((a) => (a && (a.uid || a)) )
        .filter(Boolean);
      const next = incoming
        .map((a) => ({ uid: (a && (a.uid || a)), name: (a && a.name) || '' }))
        .filter((a) => a.uid);
      addedUids = next.map((a) => a.uid).filter((u) => !prevUids.includes(u));
      attendees = next;
    }
    await this.db.await_proc('mfs_set_metadata',
      nid,
      {
        content: {
          attendees, title, message, date, stime, etime, recur,
          created_by: content.created_by, room_id: nid
        },
        room_status: 'booked'
      }, 1);
    // In-app popup for newly-invited workspace members (fire-and-forget).
    if (addedUids.length) {
      this._notify_invitees(addedUids, {
        type: 'meeting_scheduled',
        nid,
        title,
        date,
        stime,
        recur,
        from: name,
      });
    }

    // Durable notifications. The live push above is socket-only: it is gone on
    // reload and never reaches anyone who was offline, which is why an invitee
    // saw only "<organizer> uploaded <Meeting-name>" in the Files tab.
    //
    // Resolved once and shared by both notices below; skipped entirely when
    // there is nobody to tell, so an ordinary title/agenda edit costs nothing.
    const movedTo = Number(stime) || 0;
    const timeChanged = movedTo !== prevStime && movedTo > 0;
    const attendeeUids = (isArray(attendees) ? attendees : [])
      .map((a) => (a && (a.uid || a)))
      .filter(Boolean);
    // A newly-added attendee gets the invitation, not a reschedule notice —
    // they were never told the old time.
    const rescheduleUids = timeChanged
      ? attendeeUids.filter((u) => !addedUids.includes(u))
      : [];
    if (addedUids.length || rescheduleUids.length) {
      const folder_name = await this._meeting_folder_name(node && node.parent_id);
      const common = {
        nid,
        pid: (node && node.parent_id) || null,
        title,
        stime: movedTo,
        folder_name,
      };
      if (addedUids.length) {
        await this._meeting_notice(addedUids, 'invite', common);
      }
      if (rescheduleUids.length) {
        await this._meeting_notice(rescheduleUids, 'moved', common);
      }
    }
    content = {
      attendees, title, message, date, stime, etime, recur,
      created_by: content.created_by
    };
    // Keep the global reminder index in lockstep with the edited meeting
    // (attendee set, moved time, cleared/added recurrence).
    await this._index_meeting(nid, content);
    await this.output.data((content));
  }

  /**
   * Persist a scheduled-meeting notice for each recipient (Duy 2026-08-21,
   * issues 9 and 11).
   *
   * Until now the meeting lifecycle produced NO durable notification at all:
   * booking was only visible as the media rollup for the `schedule` node ("X
   * uploaded <Meeting-name>", in Files), an invitation was a live socket push
   * that vanished on reload, a time change announced nothing, and a deletion
   * silently removed the rollup row too — `permission_revoke` DELETEs a
   * `schedule` media row outright, so there was nothing left to notify from.
   *
   * `meeting_notice` is one yp.contact_activity event with `kind` in
   * { invite | moved | cancelled }, mirroring how the task events already ride
   * contact_activity: per-person, dismissable, and bucketed to Meeting by
   * activity.js's BUCKET_BY_EVENT.
   *
   * Everything the row has to render is written HERE, at emit time, rather than
   * resolved when the feed is read — a cancelled meeting's node no longer exists
   * by then, so its title and folder could never be looked up afterwards.
   *
   * Best-effort per recipient: a failed write must never fail the booking, the
   * edit or the deletion that triggered it.
   *
   * @param {string[]} uids     recipients (self is dropped)
   * @param {string} kind       'invite' | 'moved' | 'cancelled'
   * @param {object} payload    { nid, pid, title, stime, folder_name }
   */
  async _meeting_notice(uids, kind, payload = {}) {
    try {
      const targets = toArray(uids)
        .map((u) => (u && (u.uid || u)))
        .filter((u) => u && u !== this.uid);
      if (isEmpty(targets)) return;
      const hub_id = this.hub.get(Attr.id);
      const meta = {
        kind,
        hub_id,
        nid: payload.nid || null,
        // The meeting node's PARENT — what the row's click opens. The node
        // itself is gone for a cancellation.
        pid: payload.pid || null,
        title: (payload.title || '').slice(0, 255),
        stime: Number(payload.stime) || 0,
        folder_name: payload.folder_name || null,
      };
      const seen = new Set();
      for (const target_uid of targets) {
        if (seen.has(target_uid)) continue;
        seen.add(target_uid);
        try {
          await this.yp.await_proc(
            'contact_log_activity', this.uid, target_uid, 'meeting_notice', meta,
          );
        } catch (e) {
          this.warn && this.warn('room._meeting_notice log failed', e && e.message);
        }
      }
    } catch (e) {
      this.warn && this.warn('room._meeting_notice failed', e && e.message);
    }
  }

  /**
   * The display name of a meeting's containing folder, for the card's chip.
   * `mfs_node_attr` answers with the WORKSPACE name when the parent is the hub
   * root, which is exactly right — room.book() files meetings at the workspace
   * root by default. Internal plumbing names are withheld, and any failure
   * simply yields no chip.
   */
  async _meeting_folder_name(pid) {
    try {
      if (!pid || `${pid}` === '0') return null;
      const a = await this.db.await_proc('mfs_node_attr', pid);
      const name = a && a.filename;
      if (!name || /^__.*__$/.test(name) || name.indexOf('__') === 0) return null;
      return name;
    } catch (e) {
      return null;
    }
  }

  /**
   * Push an in-app "you're invited" notification to workspace members by uid
   * (their active sockets). No email — workspace-internal only. Best-effort.
   */
  async _notify_invitees(uids, data) {
    try {
      if (isEmpty(uids)) return;
      let recipients = toArray(await this.yp.await_proc('user_sockets', uids));
      recipients = recipients.filter((r) => r && r.uid != this.uid);
      if (isEmpty(recipients)) return;
      await RedisStore.sendData(this.payload(data, { service: 'room.scheduled' }), recipients);
    } catch (e) {
      this.warn && this.warn('room._notify_invitees failed', e);
    }
  }

  /**
   * Write-through the scheduled meeting into the GLOBAL yp.meeting_schedule
   * index so the reminderWorker can poll for meetings whose start time has
   * arrived without scanning every hub's media table. Best-effort — a failure
   * here must never break booking. A meeting without a queryable stime isn't a
   * time-driven reminder, so its index row (if any) is dropped instead.
   */
  async _index_meeting(nid, content = {}) {
    try {
      if (!nid) return;
      const hub_id = this.hub.get(Attr.id);
      const stime = Number(content.stime) || 0;
      if (!stime) return this._unindex_meeting(nid);
      const attendees = (isArray(content.attendees) ? content.attendees : [])
        .map((a) => a && (a.uid || a))
        .filter(Boolean);
      await this.yp.await_proc('meeting_schedule_upsert',
        hub_id,
        nid,
        stime,
        Number(content.etime) || 0,
        content.created_by || this.uid,
        (content.title || '').slice(0, 255),
        // Agenda, for the reminder card's description line. Bounded: it is a
        // notification subtitle, not the whole note.
        (content.message || '').slice(0, 2000),
        JSON.stringify(attendees),
        content.recur ? JSON.stringify(content.recur) : null,
      );
    } catch (e) {
      this.warn && this.warn('room._index_meeting failed', e);
    }
  }

  /**
   * Drop a meeting from the global reminder index (delete / cleared start time).
   */
  async _unindex_meeting(nid) {
    try {
      if (!nid) return;
      const hub_id = this.hub.get(Attr.id);
      await this.yp.await_proc('meeting_schedule_remove', hub_id, nid);
    } catch (e) {
      this.warn && this.warn('room._unindex_meeting failed', e);
    }
  }

  /**
   * List the current hub's scheduled meetings whose time window overlaps
   * [stime, etime] (UNIX-epoch seconds). Both bounds optional — omit to list
   * every scheduled meeting (full refresh). Feeds the folder-window calendar.
   */
  async list() {
    const stime = this.input.use(Attr.stime, null);
    const etime = this.input.use(Attr.etime, null);
    // toArray + output.list, NOT the raw call_proc handler: row unwrapping
    // collapses a single-row result set into a bare object, so a range holding
    // exactly one meeting answered `{...}` where every other count answers
    // `[...]`. The calendar read that object as "no meetings" and emptied
    // itself — deleting one of two same-time meetings made the survivor vanish
    // as well, while its start-time reminder kept firing.
    const rows = toArray(await this.db.await_proc('room_list_scheduled', stime, etime));
    this.output.list(rows);
  }

  /**
   * Free/busy for a proposed slot (workspace-scoped). Given attendee uids +
   * [stime, etime], returns which invitees already have a meeting IN THIS HUB
   * overlapping that slot. Warn-only — the client still lets the organizer
   * book. `nid` (the meeting being edited) is excluded from its own check.
   * Returns [{ uid, busy, conflicts:[{nid,title,stime,etime}] }].
   */
  async check_availability() {
    const stime = this.input.need(Attr.stime);
    const etime = this.input.need(Attr.etime);
    const exclude = this.input.use(Attr.nid, null);
    let attendees = this.input.use(Attr.attendees, []);
    if (!isArray(attendees)) attendees = attendees ? [attendees] : [];
    const uids = attendees.map((a) => a && (a.uid || a)).filter(Boolean);

    const rows = toArray(await this.db.await_proc('room_list_scheduled', stime, etime));
    const meetings = [];
    for (const r of rows) {
      if (exclude && r.id == exclude) continue;
      const content = this.parseJSON(this.parseJSON(r.metadata).content);
      const s = Number(content.stime);
      const e = Number(content.etime) || s;
      if (!s || !(s <= etime && e >= stime)) continue; // must actually overlap
      const parts = [];
      if (content.created_by) parts.push(content.created_by);
      if (isArray(content.attendees)) {
        for (const a of content.attendees) parts.push(a && (a.uid || a));
      }
      meetings.push({ nid: r.id, title: content.title, stime: s, etime: e, parts });
    }

    const result = uids.map((uid) => {
      const conflicts = meetings
        .filter((m) => m.parts.includes(uid))
        .map((m) => ({ nid: m.nid, title: m.title, stime: m.stime, etime: m.etime }));
      return { uid, busy: conflicts.length > 0, conflicts };
    });
    this.output.data(result);
  }

  /**
   * 
   */
  async get_meeting_members() {
    const nid = this.input.need(Attr.nid);
    this.db.call_proc('dmz_get_meeting_members', this.uid, nid, this.output.data);
  }


  /**
   * 
   */
  async remove() {
    const nid = this.input.need(Attr.nid);
    // Owner-only delete (legacy meetings without a recorded creator pass).
    const node = await this.db.await_proc('mfs_node_attr', nid);
    const content = this.parseJSON(this.parseJSON(node.metadata).content);
    if (content.created_by && content.created_by !== this.uid) {
      this.exception.user("NOT_MEETING_OWNER");
      return;
    }
    // Tell the attendees BEFORE the node goes away. permission_revoke DELETEs a
    // `schedule` media row outright, so after this line the title, the start
    // time and the parent folder are unrecoverable — and the media rollup that
    // used to be the only sign of the meeting disappears with it, which is why a
    // cancellation announced nothing at all (Duy 2026-08-21, issue 11).
    const cancelAttendees = (isArray(content.attendees) ? content.attendees : [])
      .map((a) => (a && (a.uid || a)))
      .filter(Boolean);
    if (cancelAttendees.length) {
      await this._meeting_notice(cancelAttendees, 'cancelled', {
        nid,
        pid: (node && node.parent_id) || null,
        title: content.title || (node && node.filename) || '',
        stime: content.stime || 0,
        folder_name: await this._meeting_folder_name(node && node.parent_id),
      });
    }
    await this.db.await_proc('permission_revoke', nid, "meeting");
    await this._unindex_meeting(nid);
    this.output.data({ nid });
  }

  /**
   * 
   */
  async invite() {
    let room_id = this.input.need(Attr.room_id);
    let guest = this.input.need('guest');
    let room_type = this.input.need('room_type');
    let opt = {
      room_id,
      type: room_type,
      user_id: guest.uid,
      socket_id: guest.socket_id,
      device_id: guest.device_id,
      role: Attr.listener
    }
    let r = await this.db.await_proc('room_invite_next', JSON.stringify(opt));
    // let my_node = Cache.getEnv(Attr.endpointAddress);
    // guest.node = my_node;
    let data = {
      type: 'linkup',
      service: 'signaling.message',
      origin: {
        socket_id: this.input.get(Attr.socket_id),
        uid: this.uid,
        ...r
      },
      target: guest
    };
    this.notify_socket({ ...guest, server: guest.node }, data);
    this.output.list([{ ...guest, server: guest.node }, data]);
  }
  // /**
  //  * @param {*} sessuin_id 
  //  * @param {*} socket_id 
  //  */
  // users() {
  //   this.db.call_proc('room_users', this.input.need(Attr.id), this.output.list);
  // }
}

module.exports = __private_room;
