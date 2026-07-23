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

const { Attr, RedisStore, Cache, toArray } = require("@drumee/server-essentials");
const { isArray, isEmpty, map } = require("lodash");

const __yp = require("./yp");
class conference extends __yp {

  /**
   *
   */
  attendee() {
    this.yp.call_proc(
      "conference_attendee",
      this.input.need("participant_id"),
      this.output.data
    );
  }

  /**
   * 
   */
  async regularlUser() {
    let regsid = this.input.cookie(Attr.regsid);
    if (!regsid) return {}

    let user = await this.yp.await_proc("cookie_retrieve_user", regsid);
    const extUsers = [
      Cache.getSysConf("guest_id"), Cache.getSysConf("nobody_id")
    ]
    if (!user || extUsers.includes(user.id)) return {}
    return user;
  }

  /**
   *
   * @returns
   */
  async join() {
    let sid = this.input.sid();
    let socket_id = this.input.need(Attr.socket_id);
    let metadata = this.input.need(Attr.metadata);
    let room_id = this.input.get(Attr.room_id);
    let hub_id = this.input.need(Attr.hub_id);

    let regUser = await this.regularlUser();
    this.debug("AAA:50", regUser, { regid: regUser.id, curid: this.uid });
    metadata.uid = regUser.id || this.uid;
    let guest_name = this.input.get("guest_name");
    if (this.uid == Cache.getSysConf(Attr.guest_id)) {
      guest_name = regUser.firstname || guest_name;
      if (guest_name) {
        metadata.guest_name = guest_name;
        await this.yp.await_proc("cookie_touch", { sid, uid: this.uid, socket_id, guest_name });
      }
    }
    if (!metadata.type) {
      metadata.type = this.input.need(Attr.type);
    }
    let args = { room_id, hub_id, socket_id };
    let p = await this.yp.await_proc("conference_join", args, metadata);
    this.debug("AAA:69", { args, metadata, p })
    p = toArray(p);
    if (!p.length || !p[0].permission) {
      let failed = true;
      /** Some time guest get wrong uid (nobody_id instead of guest_id). Retry once. */
      if (this.uid == Cache.getSysConf(Attr.guest_id)) {
        await this.yp.await_proc("cookie_touch", { sid, uid: this.uid, guest_name });
        p = await this.yp.await_proc("conference_join", args, metadata);
        if (p && p.permission) {
          failed = false;
          p = toArray(p);
        }
      }
      if (failed) {
        this.exception.user("WEAK_PRIVILEGE");
        return;
      }
    }

    ({ room_id } = p[0]);

    let user = {};
    let host = null;
    let attendees = p.filter(function (e) {
      if (e.socket_id == socket_id) user = e;
      if (e.role == "host") host = e;
      return e.socket_id != socket_id;
    });

    await this.sendRoomInfo({
      user,
      room_id,
      host,
      socket_id,
      metadata,
      attendees
    })
  }
  /**
   * 
   * @param {*} user 
   * @param {*} attendees 
   */
  async sendRoomInfo(args) {
    //this.debug("AAA:112", { args });
    const {
      user,
      room_id,
      socket_id,
      metadata,
      attendees
    } = args;

    let room_type = metadata.type || this.input.need(Attr.type) || this.input.need(Attr.room_type);
    let isCallee = this.input.get("isCallee");
    let recipients = attendees;
    let payload = user;
    let details = await this.db.await_proc("mfs_node_attr", room_id);
    const isFirstJoiner = attendees.length === 0;
    if ((user.role == "host" || isFirstJoiner) && user.uid == this.uid) {
      await this.inform({ recipients, payload }, "conference.start");
      if (room_type == Attr.meeting) {
        try {
          const hub_id = this.hub.get(Attr.id);
          const hubMembers = await this.yp.await_proc('entity_sockets', { hub_id, exclude: [socket_id] });
          if (hubMembers && toArray(hubMembers).length) {
            // Include the workspace name so the recipients' meeting notification
            // ("started a meeting in <name>") isn't left blank — details (the
            // room node attrs) often carries no filename for a synthetic room_id.
            const startPayload = { ...user, details, room_type, hub_id, hub_name: this.hub.get(Attr.name) };
            await RedisStore.sendData(this.payload(startPayload, { service: 'conference.start' }), toArray(hubMembers));
          }
        } catch (e) {
          this.warn('conference.start: hub member notify failed', e && e.message);
        }
      }
    } else if (user.role == "attendee") {
      if (room_type == Attr.meeting) {
        if (payload.area == Attr.dmz) {
          recipients = await this.yp.await_proc(
            "user_sockets",
            this.hub.get(Attr.owner_id)
          );
        }
        payload.details = details;
        await this.inform({ recipients, payload }, "conference.join");
      } else if (room_type == Attr.connect) {
        let model = {
          ...user,
          details,
          room_type,
          active_id: socket_id,
        };
        let service = "conference.join";
        if (isCallee) {
          service = "conference.accept";
        }
        await RedisStore.sendData(this.payload(model, { service }), recipients);
      }
    } else {
      this.warn("127:ENEXPECTED  CASE");
    }

    await this.pushUserOnlineStatus();
    let data = {
      permission: user.permission,
      details,
      configs: myDrumee.conference,
      attendees,
      user
    }
    //this.debug("AAA:159", data)
    this.output.data(data);

  }


  /**
   *
   */
  async getInfo() {
    let id = this.input.need(Attr.id);
    let uid = this.input.use(Attr.uid) || "";
    let data = await this.yp.await_proc("conference_get", id, uid);
    this.output.data(data);
  }

  /**
   * Mark the caller's socket as having left the conference and notify the
   * remaining peers so their connect/meeting windows can close promptly.
   *
   * Historical behaviour: `conference_leave` only updated the conference
   * table; peers waited on Jitsi USER_LEFT (with a 2-second client-side
   * delay before `room.leave()` actually fired). When that signal raced
   * with the local goodbye, the other party's `window_connect` got stuck.
   * Now we explicitly inform the remaining sockets with
   * `service: "conference.leave"`; the client's push manager routes it to
   * `currentRoom.goodbye()`.
   */
  async leave() {
    let room_id = this.input.need(Attr.room_id);
    let socket_id = this.input.need(Attr.socket_id);
    let r = await this.yp.await_func('is_socket_bound', socket_id, this.session.sid());
    let remaining = await this.yp.await_proc("conference_leave", room_id, socket_id);
    if (remaining && !isArray(remaining)) remaining = [remaining];
    const recipients = (remaining || []).filter(
      (p) => p && p.socket_id && p.socket_id !== socket_id
    );
    if (recipients.length) {
      try {
        await this.inform(
          { recipients, payload: { uid: this.uid, socket_id, room_id } },
          "conference.leave"
        );
      } catch (e) {
        if (this.warn) this.warn("conference.leave: notify peers failed", e && e.message);
      }
    }
    let peers;
    if (!r) {
      peers = await this.pushUserOnlineStatus();
      return this.output.data(peers);
    }
    peers = await this.pushUserOnlineStatus();
    this.output.data(peers);
  }

  /**
   *
   */
  async broadcast() {
    let socket_id = this.input.need(Attr.socket_id);
    let event = this.input.need('event');
    let payload = this.input.need('payload');
    let exclude = [socket_id];
    let hub_id = this.hub.get(Attr.id);
    //console.log("AAA:151", hub_id);
    let recipients = await this.yp.await_proc('entity_sockets', { hub_id, exclude }) || [];
    await RedisStore.sendData(this.payload(payload, { keys: "*", event, service: this.input.get(Attr.service) }), recipients);
    this.output.data(payload);
  }

  /**
   *
   */
  async update() {
    let room_id = this.input.need(Attr.room_id);
    let socket_id = this.input.need(Attr.socket_id);
    let metadata = this.input.need(Attr.metadata);
    let event = this.input.get('event');
    let hub_id = this.hub.get(Attr.id);
    let user = await this.yp.await_proc("socket_get", socket_id);
    let exclude = [socket_id];
    if (user.user_id == this.uid) {
      metadata.uid = this.uid;
      let data = await this.yp.await_proc(
        "conference_update",
        room_id,
        socket_id,
        metadata
      );
      this.output.data(data);
    }
    let recipients = await this.yp.await_proc('entity_sockets', { hub_id, exclude }) || [];
    let data = { ...metadata, timestamp: new Date().getTime() }
    await RedisStore.sendData(this.payload(data, { keys: "*", event, service: this.input.get(Attr.service) }), recipients);
    this.output.data();
  }

  /**
   *
   */
  async cancel() {
    let room_id = this.input.need(Attr.room_id);
    let socket_id = this.input.need(Attr.socket_id);
    let recipients = await this.yp.await_proc(
      "conference_cancel",
      room_id,
      socket_id
    );
    let opt = { recipients, payload: { uid: this.uid, socket_id, room_id } };
    await this.inform(opt, this.input.get(Attr.service));
    await this.pushUserOnlineStatus();
    this.output.data();
  }

  /**
   *
   */
  async decline() {
    let caller = this.input.need("caller");
    caller.socket_id = caller.caller_id;
    let opt = { recipients: caller, payload: { ...caller, uid: this.uid } };
    await this.inform(opt, this.input.get(Attr.service));
    await this.pushUserOnlineStatus();
    this.output.data(caller);
  }

  /**
   *
   */
  async get_caller() {
    let guest_id = this.input.need("guest_id");
    let caller = await this.yp.await_proc("conference_get_caller", {
      callee_id: this.uid,
      caller_id: guest_id,
    });
    if (caller && caller.room_id) {
      this.output.data(caller);
    } else {
      this.output.data({});
    }
  }

  /**
   *
   */
  async accept() {
    let caller = this.input.need("caller");
    let socket_id = this.input.need(Attr.socket_id);
    caller.socket_id = caller.caller_id;
    let recipients = await this.yp.await_proc(
      "socket_user_connections",
      this.uid
    );
    if (recipients && !isArray(recipients)) {
      recipients = [recipients];
    }
    recipients = recipients.filter(function (e) {
      return e.socket_id != socket_id;
    });

    recipients.push(caller);
    let opt = {
      recipients,
      payload: { uid: this.uid, socket_id: this.input.need(Attr.socket_id) },
    };
    await this.inform(opt, this.input.get(Attr.service));
    this.output.data(caller);
  }

  /**
   *
   */
  async revoke() {
    let hub_id = this.input.need(Attr.hub_id);
    let room_id = this.input.get("room_id");
    let callee = this.input.need("callee");
    let socket_id = this.input.need(Attr.socket_id);

    let data = await this.yp.await_proc(
      "conference_revoke",
      hub_id,
      room_id,
      callee.drumate_id
    );
    if (!isArray(data)) data = [data];
    let payload = {};
    let clients = data.filter(function (e) {
      if (!e) return false;
      e.caller_id = socket_id;
      e.hub_id = hub_id;
      if (e.socket_id == socket_id) {
        payload = e;
      }
      return e.socket_id != null;
    });

    // Fallback: the stored proc `conference_revoke` historically only
    // returned rows when the caller's hub_id resolves to a `hub` table
    // entry. For P2P calls hub_id is the caller's own user id, so the
    // proc returned 0 rows and the callee's ringing window stayed open.
    // When that happens, resolve the callee's active sockets directly so
    // we can still broadcast `conference.revoke` to them. Independent of
    // the patched proc — both work, and this keeps prod stable while the
    // SQL patch rolls out.
    if (!clients.length && callee && callee.drumate_id) {
      try {
        let fallback = await this.yp.await_proc(
          "socket_user_connections",
          callee.drumate_id
        );
        if (fallback && !isArray(fallback)) fallback = [fallback];
        clients = (fallback || []).filter((e) => e && e.socket_id);
        clients.forEach((e) => {
          e.caller_id = socket_id;
          e.hub_id = hub_id;
          e.room_id = room_id;
        });
      } catch (e) {
        if (this.warn) this.warn("conference.revoke fallback failed", e && e.message);
      }
    }

    let opt = { recipients: clients, payload };
    await this.inform(opt, this.input.get(Attr.service));
    this.input.set({ event: Attr.cancel });
    await this.writeLog(callee);

    this.output.data({ room_id });
  }

  /**
   *
   */
  async invite() {
    let hub_id = this.input.need(Attr.hub_id);
    let guest_id = this.input.need("guest_id");
    let room_id = this.input.get("room_id");
    let socket_id = this.input.need(Attr.socket_id);
    let metadata = this.input.need(Attr.metadata);
    metadata.uid = this.uid;
    let pending = await this.yp.await_proc("conference_pending_call", {
      hub_id,
      callee_id: guest_id,
      caller_id: this.uid,
    });
    if (isArray(pending)) pending = pending[0];
    if (pending && pending.cross_call && pending.hub_id) {
      let caller = await this.yp.await_proc("conference_get_caller", {
        callee_id: this.uid,
        caller_id: guest_id,
      });
      if (caller && caller.room_id) pending.caller = caller;
      this.output.data(pending);
      return;
    }
    let args = { hub_id, guest_id };
    if (room_id) args.room_id = room_id;
    let data = await this.yp.await_proc("conference_invite", args);
    if (!data || data.offline) {
      this.output.data(data);
      return;
    }
    if (data[1] && data[1].length) data = data[1];

    let payload = this.user.get("profile") || {};
    let clients = toArray(data).filter(function (e) {
      if (e.socket_id != null) {
        e.caller_id = socket_id;
        e.hub_id = hub_id;
        if (e.socket_id == socket_id) {
          payload = e;
        }
        return true;
      }
      return false;
    });

    if (!clients || !clients.length) {
      this.output.data({ offline: 1, uid: guest_id });
      return;
    }
    room_id = clients[0].room_id;
    let nid = room_id;

    args = { room_id, hub_id, socket_id };

    let p = await this.yp.await_proc("conference_join", args, metadata);
    if (p && !isArray(p)) p = [p];
    if (!p.length || !p[0].permission) {
      this.exception.user("WEAK_PRIVILEGE");
      return;
    }
    payload = {
      ...payload,
      room_id,
      hub_id,
      caller_id: socket_id,
      uid: this.uid,
    };
    if (!payload.name) payload.name = payload.firstname;
    let opt = { recipients: clients, payload };
    await this.inform(opt, this.input.get(Attr.service));
    this.output.data({ room_id, nid });
  }

  /**
   *
   */
  async inform(data, service) {
    let { recipients, payload } = data;
    let metadata = this.input.get(Attr.metadata) || {};
    if (!recipients) return;
    let sender = { socket_id: this.input.get(Attr.socket_id) };
    let model = { ...payload, room_type: metadata.type, type: service };
    await RedisStore.sendData(
      this.payload(model, { service, sender }),
      recipients
    );
  }

  /**
   *
   * @param {*} contact_id
   * @returns
   */
  async contactInfo(db_name, entity_id) {
    let entity = await this.yp.await_proc(
      `${db_name}.shareroom_contact_get`,
      entity_id
    );
    if (!isEmpty(entity.contact_id)) {
      let tag = await this.yp.await_proc(
        `${db_name}.my_tag_get`,
        entity.contact_id
      );
      if (!isArray(tag)) {
        tag = [tag];
      }
      entity.tag = map(tag, "tag_id");
    }
    return entity || {};
  }

  /**
   *
   * @param {*} input
   * @param {*} my_id
   * @param {*} hid_id
   */
  async writeLog(callee) {
    let author_id = this.uid;
    let entity_id = callee.entity_id;
    let contact_id = callee.contact_id;
    let event = this.input.need("event");
    let duration = this.input.get("duration") || 0;
    let msg_type = "call";
    let recipients;
    let service = "chat.post";

    if (!/^(cancel|leave|reject|decline)$/.test(event)) return;

    let message_id = await this.yp.await_func("uniqueId");
    let peer = await this.yp.await_proc("get_entity", entity_id);
    let author = await this.yp.await_proc("get_entity", this.uid);

    let peer_id = entity_id;

    // P2P call logs must land in p2p_channel — the store chat.messages reads
    // through p2p_list_messages. The legacy `channel` table this used to write
    // to is no longer read by any p2p surface, so those rows were invisible in
    // chat-p2p and bigchat alike.
    //
    // Like every other p2p message this is a SINGLE write in the caller's DB
    // with peer_id = callee; p2p_list_messages unions both sides, so the callee
    // reads the same row cross-DB. p2p_post_message also marks the author
    // _seen_/_delivered_, which is what the old acknowledge_message call did.
    //
    // One shared row means `role` can no longer be baked per copy, so carry
    // caller_id and let each side derive incoming-vs-outgoing. `role` stays for
    // rows written before this change.
    let metadata = {
      message_type: msg_type,
      call_status: event,
      duration: duration,
      role: "caller",
      caller_id: author_id,
    };

    let myinput = {
      message_id: message_id,
      author_id: author_id,
      peer_id: peer_id,
      metadata,
    };

    let mydata = await this.yp.await_proc(
      `${author.db_name}.p2p_post_message`,
      myinput,
      msg_type
    );

    if (!isEmpty(mydata)) {
      mydata.entity = await this.contactInfo(author.db_name, contact_id);
      let mycount = await this.yp.await_proc(
        `${author.db_name}.count_yet_read_next`,
        author_id,
        peer_id
      );
      mydata.room = mycount.room;
      mydata.total = mycount.total;

      mydata.service = "chat.post";
      mydata.to_id = author_id;
      recipients = await this.yp.await_proc("user_sockets", author_id);
      await RedisStore.sendData(this.payload(mydata, { service }), recipients);

      // Same row, second push. peer_id must name the OTHER party from each
      // recipient's point of view — the chat widget matches it against its own
      // peerId (chat/index.js onWsMessage → privateMach), so a payload without
      // it (or with the callee's own id) is silently dropped and the call event
      // only appears after a reload.
      let hisdata = { ...mydata, peer_id: author_id };
      let hiscount = await this.yp.await_proc(
        `${peer.db_name}.count_yet_read_next`,
        peer_id,
        author_id
      );
      hisdata.entity = await this.contactInfo(peer.db_name, contact_id);
      hisdata.service = "chat.post";
      hisdata.room = hiscount.room;
      hisdata.total = hiscount.total;
      hisdata.to_id = peer_id;
      recipients = await this.yp.await_proc("user_sockets", peer_id);
      await RedisStore.sendData(this.payload(hisdata, { service }), recipients);
    }
  }

  /**
   *
   */
  async logCall() {
    let callee = this.input.need("callee");
    await this.writeLog(callee);
    this.output.data(callee);
  }
}

module.exports = conference;
