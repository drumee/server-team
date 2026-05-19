// File: service/private/activity.js
// Purpose: MFS activity notification service - handle read/unread status

const { Entity } = require('@drumee/server-core');
const { Attr, toArray } = require('@drumee/server-essentials');

class MfsActivity extends Entity {


  /**
   * Call stored procedure in user's database
   * Ensures procedures run in user context, not hub context
   * 
   * @param {string} procName - Procedure name
   * @param {...any} args - Procedure arguments
   */
  async _callUserProc(procName, ...args) {
    // const argsStr = args.map(arg => {
    //   if (typeof arg === 'string') return `'${arg}'`;
    //   if (typeof arg === 'object') return `'${JSON.stringify(arg)}'`;
    //   return String(arg);
    // }).join(', ');
    const proc = `${this.user.get(Attr.db_name)}.${procName}`;
    this.debug(`[MFS_ACTIVITY] Calling ${proc}`, ...args);

    // Call via forward_proc to ensure it runs in user's database
    const result = await this.yp.await_proc(`${proc}`, ...args);

    // this.debug(`[MFS_ACTIVITY] Result from ${procName}:`, result);

    return result;
  }

  /**
   * Get count of unread notifications
   * Endpoint: GET /mfs_activity.get_unread_count
   * 
   * Output:
   * - unread_count: Number of unread notifications
   */
  async get_unread_count() {
    const result = await this._callUserProc('mfs_get_unread_count', this.uid);
    const data = toArray(result)[0] || { unread_count: 0 };

    return this.output.data({
      status: 'ok',
      unread_count: data.unread_count
    });
  }

  /**
   * Mark all notifications as read
   * Endpoint: POST /mfs_activity.mark_all_read
   * 
   * Input:
   * - last_id (optional): Specific changelog ID to mark as last read
   *                       If not provided, will use the latest changelog ID
   * 
   * Output:
   * - status: ok or error
   * - last_read_id: The ID that was marked as last read
   */
  async mark_all_read() {

    const lastId = parseInt(this.input.get('last_id')) || 0;

    this.debug(`[MFS_ACTIVITY] Marking all read for user ${this.uid}, last_id: ${lastId}`);

    const result = await this._callUserProc('mfs_mark_all_read', this.uid, lastId);
    const data = toArray(result)[0];

    if (data && data.status === 'ok') {
      return this.output.data({
        status: 'ok',
        message: 'All notifications marked as read',
        last_read_id: data.last_read_id,
        mtime: data.mtime
      });
    }

    this.warn('[MFS_ACTIVITY] mark_all_read failed:', data);
    return this.output.data({
      status: 'error',
      message: 'Failed to mark as read',
      last_read_id: 0,
    });
  }

  /**
   * Get activity feed with pagination
   * Endpoint: GET /mfs_activity.get_feed
   * 
   * Input:
   * - limit (optional): Number of items per page (default: 20)
   * - offset (optional): Offset for pagination (default: 0)
   * 
   * Output:
   * - items: Array of activity items with read status
   * - pagination: { limit, offset, has_more }
   */
  async get_feed() {
    const page = this.input.use(Attr.page) || 1;
    const filter = this.input.use('filter') || 'all';
    const unreadOnly = parseInt(this.input.use('unread_only') || 0);
    const proc = unreadOnly ? 'mfs_get_activity_feed' : 'activity_get_log';
    let result = await this._callUserProc(proc, this.uid, page);
    result = toArray(result);
    if (filter === 'mentions') {
      result = result.filter((row) => row.event !== 'media.share');
    } else if (filter === 'shares') {
      result = result.filter((row) => row.event === 'media.share');
    }
    this.output.list(result);
  }


  /**
   * Get unified activity log (contacts + MFS)
   * Endpoint: GET /activity.log
   * 
   * Priority: ALL contact events first, then ALL MFS events
   */
  async log() {
    const page = this.input.use(Attr.page) || 1;
    this.debug(`[ACTIVITY] Getting unified log for user ${this.uid}, page: ${page}`);
    
    const result = await this._callUserProc('activity_get_log', this.uid, page);
    
    this.output.list(result);
  }

  /**
   * Get activity log for a specific folder
   * Endpoint: GET /activity.folder_log
   * Shows MFS events related to a specific folder/node
   */
  async folder_log() {
    const nid = this.input.need(Attr.nid);
    const page = this.input.use(Attr.page) || 1;
    
    this.debug(`[ACTIVITY] Getting folder log for nid: ${nid}, user: ${this.uid}, page: ${page}`);
    
    const result = await this._callUserProc('activity_get_folder_log', this.uid, nid, page);
    
    this.output.list(result);
  }

  /**
   * Get last read information
   * Endpoint: GET /mfs_activity.get_last_read
   * 
   * Output:
   * - last_read_id: Last changelog ID marked as read
   */
  async get_last_read() {
    // Get user's database name
    const userDb = await this.yp.await_query(
      'SELECT db_name FROM yp.entity WHERE id = ?',
      this.uid
    );
    const userDbName = toArray(userDb)[0]?.db_name;

    if (!userDbName) {
      this.warn(`[MFS_ACTIVITY] User database not found for ${this.uid}`);
      return this.output.data({
        user_id: this.uid,
        last_read_id: 0,
        mtime: 0
      });
    }

    this.debug(`[MFS_ACTIVITY] Querying mfs_ack from ${userDbName}`);

    // Query mfs_ack from user's database
    const result = await this.db.await_query(
      'SELECT user_id, last_read_id, mtime FROM ${userDbName}.mfs_ack WHERE user_id = ?',
      this.uid
    );

    const data = toArray(result)[0];

    if (data) {
      this.output.data(data);
    } else {
      this.output.data({
        user_id: this.uid,
        last_read_id: 0,
        mtime: 0
      });
    }

  }

  /**
  * Acknowledge/mark a specific file as seen
  * 
  * This replaces the old media.mark_as_seen which used JSON metadata
  * New approach: Uses mfs_changelog + mfs_ack for better performance
  * 
  */
  async acknowledge_file() {
    const nodeId = this.input.need(Attr.nid);
    const userId = this.uid;

    this.debug(`[MFS_ACTIVITY] Acknowledging file: ${nodeId} for user: ${userId}`);

    const result = await this._callUserProc('mfs_acknowledge_file', userId, nodeId);
    const data = toArray(result)[0];

    if (data && data.status === 'ok') {
      const recipients = await this.yp.await_proc('user_sockets', userId);
      const keys = { entity_id: Attr.hub_id };

      await RedisStore.sendData(
        this.payload(data, { keys }),
        recipients
      );

      await RedisStore.sendData(
        this.payload({}, { service: 'notification.resync' }),
        recipients
      );

      return this.output.data({
        status: 'ok',
        message: 'File acknowledged',
        last_read_id: data.last_read_id,
        mtime: data.mtime
      });

    }
    this.warn('[MFS_ACTIVITY] acknowledge_file failed:', data);
    this.output.data({
      status: 'error',
      message: 'File not acknowledged',
    });

  }

  async dismiss() {
    const changelogId = parseInt(this.input.need('changelog_id'));
    const result = await this._callUserProc('mfs_dismiss_activity', this.uid, changelogId);
    const data = toArray(result)[0] || {};
    this.output.data(data);
  }

  /**
   * Hide a single contact_activity row (hub invite, contact invite, etc.)
   * from the user's activity feed. Underlying event stays around for audit.
   * Endpoint: POST /activity.dismiss_contact_event
   * Input: activity_id (integer)
   */
  async dismiss_contact_event() {
    const activityId = parseInt(this.input.need('activity_id'));
    const result = await this._callUserProc('contact_activity_dismiss', this.uid, activityId);
    const data = toArray(result)[0] || {};
    this.output.data(data);
  }

  /**
   * Unified notification dismiss for any rollup returned by drumate.notification_center.
   * Routes by `category` to the right read-pointer / status update.
   * Endpoint: POST /activity.notification_dismiss
   * Input: category (string), key_id (string), hub_id (string), last_id (integer)
   */
  async notification_dismiss() {
    const category = String(this.input.need('category'));
    const key_id = String(this.input.need('key_id'));
    const hub_id = String(this.input.use('hub_id') || '');
    const last_id = parseInt(this.input.use('last_id') || 0);
    const result = await this._callUserProc(
      'notification_dismiss',
      category,
      key_id,
      hub_id,
      last_id
    );
    const data = toArray(result)[0] || {};
    this.output.data(data);
  }

  // ============================================================
  // Unified activity API (Approach C: wrap-only consolidation)
  //
  // The activity panel and any other client should use only these
  // four endpoints; underlying tables stay where they are.
  // ============================================================

  /**
   * Single-call notification feed. Aggregates the 5 rollup categories from
   * `notification_center_next` plus the standalone hub-invite stream from
   * `yp.contact_activity` (event = 'hub_invite_received'). Result is a flat
   * array; client renders by `category`.
   *
   * Endpoint: POST /activity.list
   */
  async list() {
    const [rollups, hubInvites] = await Promise.all([
      this._callUserProc('notification_center_next'),
      this._callUserProc('notification_hub_invites'),
    ]);
    const rows = toArray(rollups);
    const hubs = toArray(hubInvites);
    const items = [
      ...rows.map((r) => ({
        category: r.category,
        key_id: r.key_id,
        hub_id: r.hub_id,
        last_id: r.last_id,
        cnt: r.cnt,
        ctime: r.ctime,
        firstname: r.firstname,
        lastname: r.lastname,
        surname: r.surname,
        email: r.email,
        status: r.status,
        contact_id: r.contact_id,
        drumate_id: r.drumate_id,
        guest_id: r.guest_id,
        area: r.area,
        tag_id: r.tag_id,
      })),
      ...hubs.map((r) => {
        let meta = {};
        if (r.data) {
          try { meta = typeof r.data === 'string' ? JSON.parse(r.data) : r.data; } catch (_) {}
        }
        return {
          category: 'hub_invite',
          key_id: String(r.id),
          hub_id: meta.hub_id || null,
          last_id: r.id,
          cnt: 1,
          ctime: r.ctime,
          firstname: meta.from_firstname || r.inviter_firstname,
          lastname: meta.from_lastname || r.inviter_lastname,
          surname: meta.from_fullname || r.hub_headline,
          email: r.inviter_email,
          author_id: r.author_id,
          hub_name: r.hub_headline || r.hub_ident,
        };
      }),
    ];
    this.output.list(items);
  }

  /**
   * Alias of `notification_dismiss` under the consolidated activity.* API.
   * Hides the rollup row from the activity feed.
   * Endpoint: POST /activity.dismiss
   */
  async dismiss_rollup() {
    return this.notification_dismiss();
  }

  /**
   * Mark a rollup as read without hiding it. For backends that distinguish
   * between read-pointer and dismissed-flag (contact, mfs_changelog), we only
   * advance the read pointer. For the others (chat/teamchat/ticket) read and
   * dismiss collapse into the same operation, so we just delegate.
   * Endpoint: POST /activity.read
   */
  async read() {
    const category = String(this.input.need('category'));
    const key_id = String(this.input.need('key_id'));
    const hub_id = String(this.input.use('hub_id') || '');
    const last_id = parseInt(this.input.use('last_id') || 0);
    const result = await this._callUserProc(
      'notification_read',
      category,
      key_id,
      hub_id,
      last_id
    );
    const data = toArray(result)[0] || {};
    this.output.data(data);
  }

  /**
   * Publish a new notification. Routes by `category` to the appropriate
   * underlying table. Public callers rarely need this — most events are
   * created as side-effects of chat.post / media.new / hub.invite. This
   * endpoint exists so future system integrations can inject notifications
   * via the `activity.*` namespace.
   * Endpoint: POST /activity.create
   * Input: category (string), key_id (string), hub_id (string), payload (object)
   */
  async create() {
    const category = String(this.input.need('category'));
    const key_id = String(this.input.need('key_id'));
    const hub_id = String(this.input.use('hub_id') || '');
    const payload = this.input.use('payload') || {};
    const result = await this.yp.await_proc(
      'activity_publish',
      category,
      this.uid,
      key_id,
      hub_id,
      JSON.stringify(payload)
    );
    const data = toArray(result)[0] || { status: 'ok', category, key_id };
    this.output.data(data);
  }
}

module.exports = MfsActivity;