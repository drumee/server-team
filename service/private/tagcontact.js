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
const { Attr } = require("@drumee/server-essentials");

const { stringify } = JSON;
const {isArray, isEmpty, after} = require('lodash');

const {Entity} = require('@drumee/server-core');
const { sqlString } = require('../lib/sql-literal');

class __private_tagcontact extends Entity {




  constructor(...args) {
    super(...args);
    this.tag_add = this.tag_add.bind(this);
    this.tag_remove = this.tag_remove.bind(this);
    this.tag_rename = this.tag_rename.bind(this);
    this.entity_assign = this.entity_assign.bind(this);
    this.tag_get_next = this.tag_get_next.bind(this);
    this.tag_assign = this.tag_assign.bind(this);
    this.tag_assign = this.tag_assign.bind(this);
    this.tag_reposition = this.tag_reposition.bind(this);
    this.entity_assign_get = this.entity_assign_get.bind(this);

  }


  /**
   * 
   */
  async tag_add() {
    const name = this.input.need(Attr.name);
    let data = await this.db.await_proc('tag_add', name, '');
    this.output.data(data);
  }


  /**
   * 
   * @returns 
   */
  tag_remove() {
    const tag_id = this.input.need(Attr.tag_id);
    return this.db.call_proc('tag_remove', tag_id, this.output.data);
  }

  /**
   * 
   * @returns 
   */
  async tag_rename() {
    const tag_id = this.input.need(Attr.tag_id);
    const name = this.input.need(Attr.name);
    let tag = await this.db.await_proc('tag_get', tag_id, null);
    if (isEmpty(tag)) {
      this.exception.user("TAG_NOT_FOUND");
      return;
    }
    let res = await this.db.await_proc('tag_rename', tag_id, name);
    this.output.data(res);
  }

  /**
   * 
   */
  async entity_assign_get() {
    let entity_id = this.input.need(Attr.entity_id);
    let tag = await this.yp.await_proc('forward_proc', this.uid, 'my_tag_get', `${sqlString(entity_id)}`)
    this.output.list(tag);
  }


  /**
   * 
   * @returns 
   */
  async entity_assign() {
    const self = this;
    let tag = this.input.use(Attr.tag) || this.input.use(Attr.list) || [];
    let entity_id = this.input.need(Attr.entity_id);
    let res = {};
    let datatag;
    let invalidtag = 0;

    if (!isArray(tag)) {
      tag = [tag];
    }

    for (let tag_id of tag) {
      datatag = await this.db.await_proc('tag_get', tag_id, null)
      if (isEmpty(datatag)) {
        invalidtag = invalidtag + 1;

      }
    }

    if (invalidtag > 0) {
      res.status = "TAG_NOT_FOUND";
      return res;
    }

    let contact = await this.db.await_proc('my_contact_get_next', entity_id, null)
    let share_room = await this.db.await_proc('mfs_access_node', this.uid, entity_id)

    if ((isEmpty(contact)) && (isEmpty(share_room))) {
      res.status = "INVALID_ENTITY";
      return res;
    }

    if ((isEmpty(contact)) && (!isEmpty(share_room))) {
      if (share_room.filetype != 'hub') {
        res.status = "INVALID_ENTITY";
        return res;
      }
    }
    await this.db.await_proc('my_tag_delete', entity_id, null);
    await this.db.await_proc('my_tag_add', entity_id, stringify(tag))
    res = await this.db.await_proc('my_tag_get', entity_id)
    let service = "tag.entity_assign";

    if (isEmpty(contact)) {
      let sockets = await this.yp.await_proc('user_sockets', this.uid);
      await redisStore.sendData(this.payload({}, {service}), sockets);
    }
    this.output.list(res);
  }

  /**
   * 
   */
  tag_get_next() {
    const tag_id = this.input.use(Attr.tag_id, '');
    const search = this.input.use(Attr.search, '');
    const order = this.input.use(Attr.order, 'desc');
    const page = this.input.use(Attr.page) || 1;
    this.db.call_proc('tag_get_next', tag_id, search, order, page, this.output.list);
  }

  /**
   * 
   * @returns 
   */
  tag_assign() {
    const tag_id = this.input.need(Attr.tag_id);
    const parent_id = this.input.need(Attr.parent_id);

    const fn_chk_tag = () => {
      return this.db.call_proc('tag_get', tag_id, null, function (tag) {
        if (isEmpty(tag)) {
          this.exception.user("TAG_NOT_FOUND");
          return;
        }
        return cnt_parent();
      }.bind(this));
    };

    const fn_chk_parent = () => {
      return this.db.call_proc('tag_get', parent_id, null, function (tag) {
        if (isEmpty(tag)) {
          this.exception.user("PARENT_TAG_NOT_FOUND");
          return;
        }
        return cnt_child();
      }.bind(this));
    };

    const fn_chk_child = () => {
      return this.db.call_proc('tag_chk_child', tag_id, parent_id, function (tag) {
        if (!isEmpty(tag)) {
          this.exception.user("CANT_ASSIGN");
          return;
        }
        return cnt_assign();
      }.bind(this));
    };

    const fn_assign = () => {
      this.db.call_proc('tag_assign', tag_id, parent_id, this.output.data);
    };

    const cnt_tag = after(1, fn_chk_tag);
    var cnt_parent = after(1, fn_chk_parent);
    var cnt_child = after(1, fn_chk_child);
    var cnt_assign = after(1, fn_assign);
    return cnt_tag();
  }


  /**
   * 
   */
  tag_reposition() {
    const list = this.input.use(Attr.content);
    this.db.call_proc('tag_reposition', stringify(list), this.output.list);
  }

}

module.exports = __private_tagcontact;
