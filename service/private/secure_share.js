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
const {
  Attr, Cache, Messenger, RedisStore, toArray
} = require('@drumee/server-essentials');
const { Mfs } = require('@drumee/server-core');
const { isEmpty } = require('lodash');
const { shouldSendNotification } = require('../lib/email-policy');
const { hashPassword } = require('../lib/secure-share-password');

class __secure_share extends Mfs {

  /**
   * Create a per-email unique secure share token for a file or folder.
   * Sends an invitation email and returns the share link.
   */
  async create() {
    const nid    = this.input.need(Attr.nid);
    const email  = this.input.need(Attr.email);
    const domain = this.input.get('domain_restriction') || '';
    const days   = this.input.get(Attr.days)  || 0;
    const hours  = this.input.get(Attr.hours) || 0;
    const expiryHours = (days * 24) + (hours * 1);

    const token    = this.randomString();
    const hub_id   = this.hub.get(Attr.id);
    const fullname = this.user.get('fullname');
    const lang     = this.user.language() || this.input.app_language();

    const rawPassword = this.input.get('password') || '';
    const passwordHash = rawPassword.trim() ? hashPassword(rawPassword.trim()) : '';

    const row = await this.yp.await_proc(
      'secure_share_create',
      token, hub_id, nid, this.uid, email, domain, expiryHours, passwordHash
    );

    if (isEmpty(row)) {
      return this.output.data({ status: 'CREATE_FAILED' });
    }

    const host = this.hub.get(Attr.vhost);
    const link = `${this.input.homepath(host)}#/dmz/share/${token}`;

    if (await shouldSendNotification(this.yp, email)) {
      try {
        const attr    = await this.db.await_proc('mfs_node_attr', nid) || {};
        const filesize = require('filesize');
        const subject  = Cache.message('_sent_you_files', lang).format(fullname, 1);
        const msg = new Messenger({
          template  : 'butler/outbound',
          subject   : `Drumee: ${subject}`,
          recipient : email,
          lex       : Cache.lex(lang),
          data      : {
            icon      : this.hub.get(Attr.icon),
            files     : [{ filename: attr.filename || '', filesize: filesize(attr.filesize || 0) }],
            subject   : Cache.message('_outbound_default_msg', lang).format(fullname),
            message   : '',
            recipient : email.replace(/@.+$/, ''),
            signature : fullname,
            link,
          },
          handler : this.exception.email
        });
        await msg.send();
      } catch (e) {
        this.warn('[secure_share.create] email send failed:', e && e.message);
      }
    }

    this.output.data({ ...row, link });
  }

  /**
   * List all secure share tokens created by the current user for a given node.
   */
  async list() {
    const nid    = this.input.need(Attr.nid);
    const hub_id = this.hub.get(Attr.id);
    const rows   = toArray(await this.yp.await_proc('secure_share_list', hub_id, nid, this.uid));
    const base   = this.input.homepath(this.hub.get(Attr.vhost));
    this.output.list(rows.map(r => ({ ...r, link: `${base}#/dmz/share/${r.id}` })));
  }

  /**
   * Revoke a secure share token (soft delete).
   * Broadcasts a real-time event so the recipient loses access immediately.
   */
  async revoke() {
    const token  = this.input.need(Attr.token);
    const hub_id = this.hub.get(Attr.id);

    const row = toArray(
      await this.yp.await_proc('secure_share_revoke', token, this.uid)
    )[0] || {};

    // Only broadcast if the revoke actually happened (procedure returns empty otherwise)
    if (!isEmpty(row) && row.revoked_at) {
      const eventData = {
        event           : 'secure_share_revoked',
        token,
        nid             : row.node_id,
        recipient_email : row.recipient_email,
      };
      const svcOpt = { service: 'share.track_event' };

      try {
        // Broadcast to hub members (sender's window refreshes its list)
        const recipients = await this.yp.await_proc('entity_sockets', { hub_id });
        await RedisStore.sendData(this.payload(eventData, svcOpt), recipients);
      } catch (e) {
        this.warn('[secure_share.revoke] hub broadcast failed:', e && e.message);
      }

      // Also target the recipient's socket directly using the socket_id stored at
      // access time — entity_sockets() won't include guest sockets.
      if (row.active_socket_id) {
        try {
          await RedisStore.sendData(
            this.payload(eventData, svcOpt),
            [{ socket_id: row.active_socket_id }]
          );
        } catch (e) {
          this.warn('[secure_share.revoke] recipient broadcast failed:', e && e.message);
        }
      }
    }

    this.output.data(row);
  }

  /**
   * Hard-delete a token. Only allowed when it is already revoked or expired.
   */
  async delete() {
    const token = this.input.need(Attr.token);
    const res   = toArray(
      await this.yp.await_proc('secure_share_delete', token, this.uid)
    )[0] || {};
    this.output.data(res);
  }

}

module.exports = __secure_share;
