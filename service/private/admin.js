/**
 * @license
 * Copyright 2024 Thidima SA. All Rights Reserved.
 * Licensed under the GNU AFFERO GENERAL PUBLIC LICENSE, Version 3
 */
const { Attr, toArray } = require("@drumee/server-essentials");
const { Entity } = require("@drumee/server-core");
const { isEmpty } = require("lodash");

class __admin extends Entity {

  // INTERNAL HELPER
  async _get_workspace_admin_uids(domain_id) {
    const hubs = await this.yp.await_proc('member_list_hubs_by_domain', domain_id);
    const hubList = toArray(hubs);
    const adminMap = {};
    for (const hub of hubList) {
      const rows = await this.yp.await_proc(
        `${hub.db_name}.hub_get_workspace_admins`
      );
      for (const row of toArray(rows)) {
        adminMap[row.uid] = true;
      }
    }
    return Object.keys(adminMap);
  }

  // ADMIN CONSOLE — MEMBER TAB
  async member_stats() {
    let org = await this.yp.await_proc('organisation_get', this.user.domain_id());
    if (isEmpty(org)) return this.output.status('NO_ORG');
    let res = await this.yp.await_proc('member_list_stats', org.id);
    this.output.json(res || {});
  }

  async member_list_workspaces() {
    let uid = this.input.need(Attr.uid);
    let res = await this.yp.await_proc(
      'member_list_workspaces',
      uid,
      this.user.domain_id()
    );
    this.output.list(res);
  }

  async member_list_workspace_admins() {
    let res = await this.yp.await_proc(
      'member_list_workspaces',
      null,
      this.user.domain_id()
    );
    const adminUids = await this._get_workspace_admin_uids(this.user.domain_id());
    const filtered = toArray(res).filter(r => adminUids.includes(r.uid));
    this.output.list(filtered);
  }

  async member_save_workspace_roles() {
    let uid         = this.input.need(Attr.uid);
    let assignments = this.input.need('assignments');
    // assignments = [{ hub_id, privilege }, ...]
    let list = Array.isArray(assignments) ? assignments : JSON.parse(assignments);
    await this.yp.await_proc(
      'member_save_workspace_roles',
      uid,
      JSON.stringify(list)
    );
    this.output.status('OK');
  }

  async member_device_list() {
    let uid = this.input.need(Attr.uid);
    let res = await this.yp.await_proc('member_device_list', uid);
    this.output.list(res);
  }

  async member_device_remove() {
    let uid       = this.input.need(Attr.uid);
    let device_id = this.input.need('device_id');
    await this.yp.await_proc('member_device_remove', device_id, uid);
    this.output.status('OK');
  }

  async member_device_remove_all() {
    let uid = this.input.need(Attr.uid);
    await this.yp.await_proc('member_device_remove_all', uid);
    this.output.status('OK');
  }

  async member_set_workspace_admin() {
    let uid = this.input.need(Attr.uid);
    let hub_id = this.input.need(Attr.hub_id);
    let hub_db = await this.yp.await_func('get_db_name', hub_id);
    if (!hub_db) return this.output.status('HUB_NOT_FOUND');
    await this.yp.await_proc(
      `${hub_db}.permission_grant`,
      '*', uid, 0, 31, 'system', 'set as workspace admin'
    );
    this.output.status('OK');
  }

  async member_remove_workspace_admin() {
    let uid = this.input.need(Attr.uid);
    let hub_id = this.input.need(Attr.hub_id);
    let hub_db = await this.yp.await_func('get_db_name', hub_id);
    if (!hub_db) return this.output.status('HUB_NOT_FOUND');
    await this.yp.await_proc(
      `${hub_db}.permission_grant`,
      '*', uid, 0, 7, 'system', 'removed from workspace admin'
    );
    this.output.status('OK');
  }

  // ADMIN CONSOLE — AUDIT LOGS TAB
  async get_audit_logs() {
    let username  = this.input.use('username', '');
    let from_time = this.input.use('from_time', 0);
    let to_time   = this.input.use('to_time', 0);
    let page      = this.input.use(Attr.page, 1);

    const hubs    = toArray(await this.yp.await_proc(
      'member_list_hubs_by_domain',
      this.user.domain_id()
    ));

    let allLogs = [];
    for (const hub of hubs) {
      const rows = toArray(await this.yp.await_proc(
        `${hub.db_name}.hub_get_audit_logs_filtered`,
        username, from_time, to_time, 1   // fetch page 1 per hub then aggregate
      ));
      rows.forEach(r => { r.hub_id = hub.id; });
      allLogs = allLogs.concat(rows);
    }

    allLogs.sort((a, b) => b.ctime - a.ctime);

    const PAGE_SIZE = 20;
    const offset    = (page - 1) * PAGE_SIZE;
    this.output.list(allLogs.slice(offset, offset + PAGE_SIZE));
  }

  async export_audit_logs() {
    let username  = this.input.use('username', '');
    let from_time = this.input.use('from_time', 0);
    let to_time   = this.input.use('to_time', 0);

    const hubs = toArray(await this.yp.await_proc(
      'member_list_hubs_by_domain',
      this.user.domain_id()
    ));

    let allLogs = [];
    for (const hub of hubs) {
      const rows = toArray(await this.yp.await_proc(
        `${hub.db_name}.hub_get_audit_logs_filtered`,
        username, from_time, to_time, 1
      ));
      rows.forEach(r => { r.hub_id = hub.id; });
      allLogs = allLogs.concat(rows);
    }

    allLogs.sort((a, b) => b.ctime - a.ctime);
    this.output.list(allLogs);
  }

  async get_audit_stats() {
    let from_time = this.input.use('from_time', 0);
    let to_time   = this.input.use('to_time', 0);
    let res = await this.yp.await_proc(
      'get_audit_stats',
      this.user.domain_id(),
      from_time,
      to_time
    );
    this.output.json(res || {});
  }

  // ADMIN CONSOLE — STORAGE TAB (org-level)
  async get_org_storage_stats() {
    let res = await this.yp.await_proc('get_org_storage_stats', this.user.domain_id());
    this.output.list(res);
  }

  async get_org_user_storage() {
    let sort_by = this.input.use('sort_by', 'usage_high');
    let page    = this.input.use(Attr.page, 1);
    let res = await this.yp.await_proc(
      'get_org_user_storage',
      this.user.domain_id(),
      sort_by,
      page
    );
    this.output.list(res);
  }

  // WORKSPACE ADMIN — MEMBER TAB
  async hub_member_list() {
    let hub_id = this.input.need(Attr.hub_id);
    let role = this.input.use('role', 'all');
    let page = this.input.use(Attr.page, 1);
    let hub_db = await this.yp.await_func('get_db_name', hub_id);
    if (!hub_db) return this.output.status('HUB_NOT_FOUND');
    let res = await this.yp.await_proc(
      `${hub_db}.hub_member_list`,
      this.user.domain_id(),
      role,
      page
    );
    this.output.list(res);
  }

  async hub_member_stats() {
    let hub_id = this.input.need(Attr.hub_id);
    let hub_db = await this.yp.await_func('get_db_name', hub_id);
    if (!hub_db) return this.output.status('HUB_NOT_FOUND');
    let res = await this.yp.await_proc(
      `${hub_db}.hub_member_stats`,
      this.user.domain_id()
    );
    this.output.json(res || {});
  }

  async hub_member_remove() {
    let hub_id = this.input.need(Attr.hub_id);
    let uid = this.input.need(Attr.uid);
    let hub_db = await this.yp.await_func('get_db_name', hub_id);
    if (!hub_db) return this.output.status('HUB_NOT_FOUND');
    let res = await this.yp.await_proc(
      `${hub_db}.hub_member_remove`,
      uid,
      this.uid
    );
    this.output.json(res || {});
  }

  // WORKSPACE ADMIN — PERMISSION TAB
  async get_workspace_overview() {
    let hub_id = this.input.need(Attr.hub_id);
    // hub_id required for scope:hub check; method returns domain-wide overview
    let res = await this.yp.await_proc(
      'get_workspace_overview',
      this.user.domain_id(),
      this.uid
    );
    this.output.list(res);
  }

  async get_hub_folders() {
    let hub_id  = this.input.need(Attr.hub_id);
    let node_id = this.input.use(Attr.node_id, null);
    let page    = this.input.use(Attr.page, 1);
    let hub_db  = await this.yp.await_func('get_db_name', hub_id);
    if (!hub_db) return this.output.status('HUB_NOT_FOUND');
    let params = { type: 'node', page };
    let res = await this.yp.await_proc(
      `${hub_db}.mfs_show_node_by`,
      node_id,
      this.uid,
      JSON.stringify(params)
    );
    this.output.list(res);
  }

  async get_folder_permissions() {
    let hub_id = this.input.need(Attr.hub_id);
    let nid    = this.input.need(Attr.nid);
    let hub_db = await this.yp.await_func('get_db_name', hub_id);
    if (!hub_db) return this.output.status('HUB_NOT_FOUND');
    let res = await this.yp.await_proc(`${hub_db}.folder_get_permissions`, nid);
    this.output.json(res || {});
  }

  async save_folder_permissions() {
    let hub_id  = this.input.need(Attr.hub_id);
    let nid     = this.input.need(Attr.nid);
    let config  = this.input.need('config');
    let hub_db  = await this.yp.await_func('get_db_name', hub_id);
    if (!hub_db) return this.output.status('HUB_NOT_FOUND');
    let configStr = typeof config === 'string' ? config : JSON.stringify(config);
    await this.yp.await_proc(`${hub_db}.folder_save_permissions`, nid, configStr);
    this.output.status('OK');
  }

  async generate_folder_otl() {
    let hub_id  = this.input.need(Attr.hub_id);
    let nid     = this.input.need(Attr.nid);
    let hub_db  = await this.yp.await_func('get_db_name', hub_id);
    if (!hub_db) return this.output.status('HUB_NOT_FOUND');
    let res = await this.yp.await_proc(`${hub_db}.folder_generate_otl`, nid, this.uid);
    this.output.json(res || {});
  }

  async revoke_folder_otl() {
    let hub_id = this.input.need(Attr.hub_id);
    let nid    = this.input.need(Attr.nid);
    let hub_db = await this.yp.await_func('get_db_name', hub_id);
    if (!hub_db) return this.output.status('HUB_NOT_FOUND');
    await this.yp.await_proc(`${hub_db}.folder_revoke_otl`, nid);
    this.output.status('OK');
  }

  // WORKSPACE ADMIN — STORAGE TAB
  async get_hub_storage_stats() {
    let hub_id = this.input.need(Attr.hub_id);
    let hub_db = await this.yp.await_func('get_db_name', hub_id);
    if (!hub_db) return this.output.status('HUB_NOT_FOUND');
    let res = await this.yp.await_proc(`${hub_db}.get_hub_storage_stats`, hub_id);
    this.output.json(res || {});
  }

  async get_hub_user_storage() {
    let hub_id  = this.input.need(Attr.hub_id);
    let sort_by = this.input.use('sort_by', 'usage_high');
    let page    = this.input.use(Attr.page, 1);
    let hub_db  = await this.yp.await_func('get_db_name', hub_id);
    if (!hub_db) return this.output.status('HUB_NOT_FOUND');
    let res = await this.yp.await_proc(
      `${hub_db}.get_hub_user_storage`,
      hub_id,
      sort_by,
      page
    );
    this.output.list(res);
  }

  async get_file_versions() {
    let hub_id = this.input.need(Attr.hub_id);
    let search = this.input.use('search', '');
    let page   = this.input.use(Attr.page, 1);
    let hub_db = await this.yp.await_func('get_db_name', hub_id);
    if (!hub_db) return this.output.status('HUB_NOT_FOUND');
    let res = await this.yp.await_proc(
      `${hub_db}.file_version_list`,
      hub_id,
      search,
      page
    );
    this.output.list(res);
  }

  async get_file_version_detail() {
    let hub_id = this.input.need(Attr.hub_id);
    let nid    = this.input.need(Attr.nid);
    let hub_db = await this.yp.await_func('get_db_name', hub_id);
    if (!hub_db) return this.output.status('HUB_NOT_FOUND');
    let res = await this.yp.await_proc(`${hub_db}.file_version_get`, nid);
    this.output.json(res || {});
  }

  async delete_file_old_versions() {
    let hub_id = this.input.need(Attr.hub_id);
    let nid    = this.input.use(Attr.nid, null);
    let hub_db = await this.yp.await_func('get_db_name', hub_id);
    if (!hub_db) return this.output.status('HUB_NOT_FOUND');
    await this.yp.await_proc(`${hub_db}.file_version_delete_old`, nid);
    this.output.status('OK');
  }

  async download_file_versions() {
    let hub_id = this.input.need(Attr.hub_id);
    let nid    = this.input.need(Attr.nid);
    let hub_db = await this.yp.await_func('get_db_name', hub_id);
    if (!hub_db) return this.output.status('HUB_NOT_FOUND');
    let res = await this.yp.await_proc(`${hub_db}.file_version_download`, nid);
    this.output.list(res);
  }

}

module.exports = __admin;