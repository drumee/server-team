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

const HEX_COLOR = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;

class __private_label extends Entity {

  constructor(...args) {
    super(...args);
    this.list   = this.list.bind(this);
    this.create = this.create.bind(this);
    this.update = this.update.bind(this);
    this.delete = this.delete.bind(this);
  }

  async _broadcast(service, data) {
    const hub_id = this.hub && this.hub.get(Attr.id);
    if (!hub_id) return;
    let dest = await this.yp.await_proc('entity_sockets', hub_id);
    dest = toArray(dest).filter((e) => e.uid != this.uid);
    if (isEmpty(dest)) return;
    await RedisStore.sendData(this.payload(data, { service }), dest);
  }

  /**
   * List all labels in the current hub.
   */
  async list() {
    const data = await this.db.await_proc('label_list');
    this.output.list(data);
  }

  /**
   * Create a new label.
   * Params: name (required), color (optional, defaults to #AEAEB2)
   */
  async create() {
    const name = this.input.need(Attr.name);
    const color = this.input.use('color', null);

    if (color != null && !HEX_COLOR.test(color)) {
      return this.exception.user('INVALID_COLOR');
    }

    const id = await this.yp.await_func('uniqueId');
    const data = await this.db.await_run(
      'CALL label_create(?, ?, ?, ?)',
      [id, name, color, this.uid]
    );
    await this._broadcast('label.create', data);
    this.output.data(data);
  }

  /**
   * Update label name and/or color.
   * Params: id (required); name / color (optional, omit to keep existing).
   */
  async update() {
    const id = this.input.need(Attr.id);
    const name = this.input.use(Attr.name, null);
    const color = this.input.use('color', null);

    if (color != null && !HEX_COLOR.test(color)) {
      return this.exception.user('INVALID_COLOR');
    }

    const data = await this.db.await_run(
      'CALL label_update(?, ?, ?)',
      [id, name, color]
    );
    if (isEmpty(data)) {
      return this.exception.user('LABEL_NOT_FOUND');
    }
    await this._broadcast('label.update', data);
    this.output.data(data);
  }

  /**
   * Delete a label. All task_label rows referencing it are removed by the SP.
   * Params: id (required)
   */
  async delete() {
    const id = this.input.need(Attr.id);
    const data = await this.db.await_proc('label_delete', id);
    const result = { id, ...data };
    await this._broadcast('label.delete', result);
    this.output.data(result);
  }
}

module.exports = __private_label;
