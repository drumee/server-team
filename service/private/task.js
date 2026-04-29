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

const { Attr } = require('@drumee/server-essentials');
const { isEmpty } = require('lodash');
const { Entity } = require('@drumee/server-core');

const VALID_STATUSES = ['todo', 'in_progress', 'to_review', 'complete'];

class __private_task extends Entity {

  constructor(...args) {
    super(...args);
    this.list = this.list.bind(this);
    this.create = this.create.bind(this);
    this.update = this.update.bind(this);
    this.update_status = this.update_status.bind(this);
    this.delete = this.delete.bind(this);
    this.link_file = this.link_file.bind(this);
    this.unlink_file = this.unlink_file.bind(this);
    this.get_linked_files = this.get_linked_files.bind(this);
  }

  /**
   * List all tasks in the current hub (folder), ordered by status column then rank.
   */
  async list() {
    const data = await this.db.await_proc('task_list');
    this.output.list(data);
  }

  /**
   * Create a new task in the current hub (folder).
   * Params: title (required), status (optional, default 'todo'), due_date (optional)
   */
  async create() {
    const title = this.input.need(Attr.title);
    let status = this.input.use(Attr.status, 'todo');
    const due_date = this.input.use('due_date', null);

    if (!VALID_STATUSES.includes(status)) {
      status = 'todo';
    }

    const id = await this.yp.await_func('uniqueId');
    // Bypass `await_proc` which coerces JS null to '' before binding —
    // STRICT_TRANS_TABLES rejects '' for nullable DATE columns.
    const data = await this.db.await_run(
      'CALL task_create(?, ?, ?, ?, ?)',
      [id, title, status, due_date, this.uid]
    );
    this.output.data(data);
  }

  /**
   * Update task title and/or due_date.
   * Params: id (required), title (optional), due_date (optional)
   */
  async update() {
    const id = this.input.need(Attr.id);
    const title = this.input.use(Attr.title, null);
    const due_date = this.input.use('due_date', null);

    const data = await this.db.await_run(
      'CALL task_update(?, ?, ?)',
      [id, title, due_date]
    );
    if (isEmpty(data)) {
      return this.exception.user('TASK_NOT_FOUND');
    }
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
    this.output.data(data);
  }

  /**
   * Delete a task. Linked files (task_file rows) are removed via CASCADE.
   * Params: id (required)
   */
  async delete() {
    const id = this.input.need(Attr.id);
    const data = await this.db.await_proc('task_delete', id);
    this.output.data({ id, ...data });
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
    this.output.data({ task_id, file_nid, ...data });
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
}

module.exports = __private_task;