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

const { Attr, RedisStore, toArray } = require('@drumee/server-essentials');
const { isEmpty } = require('lodash');
const { Entity } = require('@drumee/server-core');

const VALID_STATUSES = ['todo', 'in_progress', 'to_review', 'complete'];
const VALID_PRIORITIES = ['low', 'medium', 'high', 'urgent'];

class __private_task extends Entity {

  constructor(...args) {
    super(...args);
    this.list = this.list.bind(this);
    this.create = this.create.bind(this);
    this.update = this.update.bind(this);
    this.update_status = this.update_status.bind(this);
    this.update_assignee = this.update_assignee.bind(this);
    this.delete = this.delete.bind(this);
    this.link_file = this.link_file.bind(this);
    this.unlink_file = this.unlink_file.bind(this);
    this.get_linked_files = this.get_linked_files.bind(this);
    this.link_label = this.link_label.bind(this);
    this.unlink_label = this.unlink_label.bind(this);
    this.get_labels = this.get_labels.bind(this);
    this.search_files = this.search_files.bind(this);
  }

  /**
   * Broadcast a task event to every socket connected to the current hub
   * (sender excluded). Silently no-ops if hub_id is missing.
   */
  async _broadcast(service, data) {
    const hub_id = this.hub && this.hub.get(Attr.id);
    if (!hub_id) return;
    let dest = await this.yp.await_proc('entity_sockets', hub_id);
    dest = toArray(dest).filter((e) => e.uid != this.uid);
    if (isEmpty(dest)) return;
    await RedisStore.sendData(this.payload(data, { service }), dest);
  }

  /**
   * List tasks scoped to a folder node.
   * Params: nid (folder node id; null/absent = legacy unscoped), include_unscoped
   * (1 on the workspace-root view to also surface legacy nid-less tasks).
   */
  async list() {
    const nid = this.input.use('nid', null);
    const include_unscoped = this.input.use('include_unscoped', 0) ? 1 : 0;
    // await_run (not await_proc) preserves a JS null nid when binding.
    const data = await this.db.await_run(
      'CALL task_list(?, ?)',
      [nid, include_unscoped]
    );
    this.output.list(data);
  }

  /**
   * Validate that every uid in the list references a real drumate.
   * Returns the de-duplicated, cleaned uid array, or throws a user exception.
   */
  async _validateAssignees(uids) {
    const clean = [];
    for (const uid of uids) {
      if (!uid) continue;
      if (clean.includes(uid)) continue;
      const drumate = await this.yp.await_proc('drumate_exists', uid);
      if (isEmpty(drumate)) {
        this.exception.user('INVALID_ASSIGNEE');
        return null;
      }
      clean.push(uid);
    }
    return clean;
  }

  /**
   * Read the assignee set from the request, accepting the multi-assignee
   * `assignee_uids` array and falling back to the legacy single `assignee_uid`.
   * Returns null when the caller supplied neither key (i.e. "unchanged").
   */
  _readAssignees() {
    const raw = this.input.use('assignee_uids', null);
    if (raw != null) return toArray(raw);
    const single = this.input.use('assignee_uid', null);
    if (single != null) return single ? [single] : [];
    return null;
  }

  /**
   * Create a new task in the current hub (folder).
   * Params: title (required), description, status, priority, due_date, assignee_uid (all optional)
   */
  async create() {
    const title = this.input.need(Attr.title);
    const description = this.input.use('description', null);
    let status = this.input.use(Attr.status, 'todo');
    let priority = this.input.use('priority', 'medium');
    const due_date = this.input.use('due_date', null);
    // Folder scope: media node id of the folder the task belongs to (nullable).
    const nid = this.input.use('nid', null);
    // Multi-assignee: array (or legacy single). null/[] = unassigned.
    const assignees = (await this._validateAssignees(this._readAssignees() || []));
    if (assignees == null) return; // invalid assignee — exception already raised

    if (!VALID_STATUSES.includes(status)) status = 'todo';
    if (!VALID_PRIORITIES.includes(priority)) priority = 'medium';

    const id = await this.yp.await_func('uniqueId');
    // Bypass `await_proc` which coerces JS null to '' before binding —
    // STRICT_TRANS_TABLES rejects '' for nullable DATE / VARCHAR columns.
    let data = await this.db.await_run(
      'CALL task_create(?, ?, ?, ?, ?, ?, ?, ?)',
      [id, title, description, status, priority, due_date, this.uid, nid]
    );
    if (assignees.length) {
      // Re-reads the row with assignee_uids populated, so the response/broadcast
      // reflect the assignments.
      data = await this.db.await_run(
        'CALL task_set_assignees(?, ?)',
        [id, assignees.join(',')]
      );
    }
    await this._broadcast('task.create', data);
    this.output.data(data);
  }

  /**
   * Update task title, description, priority, and/or due_date.
   * Params: id (required); title / description / priority / due_date (optional).
   * For title / description / priority: omit the key to keep existing value.
   * For due_date: the value is always written through (pass null to clear).
   */
  async update() {
    const id = this.input.need(Attr.id);
    const title = this.input.use(Attr.title, null);
    const description = this.input.use('description', null);
    let priority = this.input.use('priority', null);
    const due_date = this.input.use('due_date', null);

    if (priority != null && !VALID_PRIORITIES.includes(priority)) {
      return this.exception.user('INVALID_PRIORITY');
    }

    const data = await this.db.await_run(
      'CALL task_update(?, ?, ?, ?, ?)',
      [id, title, description, priority, due_date]
    );
    if (isEmpty(data)) {
      return this.exception.user('TASK_NOT_FOUND');
    }
    await this._broadcast('task.update', data);
    this.output.data(data);
  }

  /**
   * Move a task to a different Kanban column.
   * Params: id (required), status (required — todo|in_progress|to_review|complete)
   */
  async update_status() {
    const id = this.input.need(Attr.id);
    let status = this.input.need(Attr.status);

    if (!VALID_STATUSES.includes(status)) {
      return this.exception.user('INVALID_STATUS');
    }

    const data = await this.db.await_proc('task_update_status', id, status);
    if (isEmpty(data)) {
      return this.exception.user('TASK_NOT_FOUND');
    }
    await this._broadcast('task.update_status', data);
    this.output.data(data);
  }

  /**
   * Replace a task's assignee set (multi-assignee).
   * Params: id (required); assignee_uids (array — the full new set; [] clears
   * all). Legacy single `assignee_uid` is still accepted.
   */
  async update_assignee() {
    const id = this.input.need(Attr.id);
    const assignees = await this._validateAssignees(this._readAssignees() || []);
    if (assignees == null) return; // invalid assignee — exception already raised

    const data = await this.db.await_run(
      'CALL task_set_assignees(?, ?)',
      [id, assignees.join(',')]
    );
    if (isEmpty(data)) {
      return this.exception.user('TASK_NOT_FOUND');
    }
    await this._broadcast('task.update_assignee', data);
    this.output.data(data);
  }

  /**
   * Delete a task. Linked files and labels are removed by the SP.
   * Params: id (required)
   */
  async delete() {
    const id = this.input.need(Attr.id);
    const data = await this.db.await_proc('task_delete', id);
    const result = { id, ...data };
    await this._broadcast('task.delete', result);
    this.output.data(result);
  }

  /**
   * Link a file (media nid) to a task. Idempotent (INSERT IGNORE).
   * Params: task_id (required), file_nid (required)
   */
  async link_file() {
    const task_id  = this.input.need('task_id');
    const file_nid = this.input.need('file_nid');

    const data = await this.db.await_proc(
      'task_link_file',
      task_id,
      file_nid,
      this.uid
    );
    await this._broadcast('task.link_file', { task_id, files: data });
    this.output.list(data);
  }

  /**
   * Unlink a file from a task.
   * Params: task_id (required), file_nid (required)
   */
  async unlink_file() {
    const task_id  = this.input.need('task_id');
    const file_nid = this.input.need('file_nid');

    const data = await this.db.await_proc('task_unlink_file', task_id, file_nid);
    const result = { task_id, file_nid, ...data };
    await this._broadcast('task.unlink_file', result);
    this.output.data(result);
  }

  /**
   * Get all files linked to a task, with media metadata.
   * Params: task_id (required)
   */
  async get_linked_files() {
    const task_id = this.input.need('task_id');
    const data = await this.db.await_proc('task_get_linked_files', task_id);
    this.output.list(data);
  }

  /**
   * Link a label to a task. Idempotent.
   * Params: task_id (required), label_id (required)
   */
  async link_label() {
    const task_id  = this.input.need('task_id');
    const label_id = this.input.need('label_id');

    const data = await this.db.await_proc('task_link_label', task_id, label_id);
    await this._broadcast('task.link_label', { task_id, labels: data });
    this.output.list(data);
  }

  /**
   * Unlink a label from a task.
   * Params: task_id (required), label_id (required)
   */
  async unlink_label() {
    const task_id  = this.input.need('task_id');
    const label_id = this.input.need('label_id');

    const data = await this.db.await_proc('task_unlink_label', task_id, label_id);
    const result = { task_id, label_id, ...data };
    await this._broadcast('task.unlink_label', result);
    this.output.data(result);
  }

  /**
   * Get all labels attached to a task.
   * Params: task_id (required)
   */
  async get_labels() {
    const task_id = this.input.need('task_id');
    const data = await this.db.await_proc('task_get_labels', task_id);
    this.output.list(data);
  }

  /**
   * Search media files in the current hub that can be linked to a task.
   * Filters by user read-permission. Files already linked to task_id
   * (when provided) are excluded.
   * Params: pattern (required, ≥1 char), task_id (optional), page (optional, default 1).
   */
  async search_files() {
    const pattern = this.input.need('pattern');
    const task_id = this.input.use('task_id', null);
    const page    = this.input.use('page', 1);

    // task_id may be null — await_run preserves the JS null when binding.
    const data = await this.db.await_run(
      'CALL task_search_linkable_files(?, ?, ?, ?)',
      [this.uid, task_id, pattern, page]
    );
    this.output.list(data);
  }
}

module.exports = __private_task;
