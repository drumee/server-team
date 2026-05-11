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
    let total   = 0;
    for (const hub of hubs) {
      const rows = toArray(await this.yp.await_proc(
        `${hub.db_name}.hub_get_audit_logs_filtered`,
        username, from_time, to_time, 1   // fetch page 1 per hub then aggregate
      ));
      rows.forEach(r => { r.hub_id = hub.id; });
      allLogs = allLogs.concat(rows);

      // Sum the real total per hub so the paginator can render an honest
      // count instead of guessing from `rows < PAGE_SIZE`.
      const countRow = toArray(await this.yp.await_proc(
        `${hub.db_name}.hub_get_audit_logs_count`,
        username, from_time, to_time
      ))[0];
      if (countRow) total += parseInt(countRow.total, 10) || 0;
    }

    allLogs.sort((a, b) => b.ctime - a.ctime);

    const PAGE_SIZE = 20;
    const offset    = (page - 1) * PAGE_SIZE;
    this.output.json({
      data: allLogs.slice(offset, offset + PAGE_SIZE),
      total,
      page,
      page_size: PAGE_SIZE,
    });
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

  async get_hub_audit_logs() {
    let hub_id = this.input.need(Attr.hub_id);
    let username = this.input.use('username', '');
    let from_time = this.input.use('from_time', 0);
    let to_time = this.input.use('to_time', 0);
    let page = this.input.use(Attr.page, 1);
    let res = await this.yp.await_proc(
      'get_hub_audit_logs',
      hub_id,
      username,
      from_time,
      to_time,
      page
    );
    this.output.list(res);
  }

  async get_audit_stats() {
    let from_time = this.input.use('from_time', 0);
    let to_time   = this.input.use('to_time', 0);

    // yp SP gives us security_score (placeholder), high_risk_count
    // (placeholder), and storage_used_bytes (real).
    let stats = await this.yp.await_proc(
      'get_audit_stats',
      this.user.domain_id(),
      from_time,
      to_time
    ) || {};

    // Replace high_risk_count with a real aggregate by summing
    // hub_count_high_risk_actions across every hub in the domain. action_log
    // lives per-hub so we can't compute this from yp alone.
    const hubs = toArray(await this.yp.await_proc(
      'member_list_hubs_by_domain',
      this.user.domain_id()
    ));
    let highRisk = 0;
    for (const hub of hubs) {
      const row = toArray(await this.yp.await_proc(
        `${hub.db_name}.hub_count_high_risk_actions`,
        from_time,
        to_time
      ))[0];
      if (row) highRisk += parseInt(row.total, 10) || 0;
    }
    stats.high_risk_count = highRisk;

    this.output.json(stats);
  }

  // ADMIN CONSOLE — STORAGE TAB (org-level)
  async get_org_storage_stats() {
    let res = await this.yp.await_proc('get_org_storage_stats', this.user.domain_id());
    this.output.list(res);
  }

  async get_org_user_storage() {
    let sort_by = this.input.use('sort_by', 'usage_high');
    let page    = this.input.use(Attr.page, 1);
    const PAGE_SIZE = 20; // matches yp.utils.pageToLimits default

    let rows = toArray(await this.yp.await_proc(
      'get_org_user_storage',
      this.user.domain_id(),
      sort_by,
      page
    ));

    // Paired count SP so the FE can render "Showing X-Y of N" without
    // guessing. The data SP runs LIMIT-bound; the count SP shares the
    // same WHERE clause minus pagination.
    const countRow = toArray(await this.yp.await_proc(
      'get_org_user_storage_count',
      this.user.domain_id()
    ))[0];
    const total = countRow ? (parseInt(countRow.total, 10) || 0) : 0;

    this.output.json({
      data: rows,
      total,
      page,
      page_size: PAGE_SIZE,
    });
  }

  // WORKSPACE ADMIN — MEMBER TAB
  async hub_member_list() {
    let hub_id = this.input.need(Attr.hub_id);
    let role = this.input.use('role_id', this.input.use('role', 'all'));
    if (!role || role === 0 || role === '0') role = 'all';
    let key = this.input.use('key', '');
    let page = this.input.use(Attr.page, 1);
    let hub_db = await this.yp.await_func('get_db_name', hub_id);
    if (!hub_db) return this.output.status('HUB_NOT_FOUND');
    let res = await this.yp.await_proc(
      `${hub_db}.hub_member_list`,
      this.user.domain_id(),
      role,
      key,
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

  // WORKSPACE ADMIN — PERMISSION TAB / MEMBER TAB OVERVIEW
  async get_workspace_overview() {
    let hub_id = this.input.need(Attr.hub_id);
    // Collaborative workspaces the caller participates in. The data
    // model has two areas that are visually "restricted" workspaces in
    // this product:
    //   - 'private'    — most common in practice (the user's data uses
    //                    this for invitable team-restricted hubs)
    //   - 'restricted' — the literal enum value
    // Plus 'share' for shared workspaces. Excluded: 'personal' (each
    // user's own space), 'system' / 'pool*' / 'template' / 'dummy'
    // / 'dmz*' (infra and one-shot share buckets — not workspaces).
    let rows = toArray(await this.yp.await_proc(
      'member_list_workspaces',
      this.uid,
      this.user.domain_id()
    ));
    const WORKSPACE_AREAS = new Set(['private', 'restricted', 'share']);
    rows = rows.filter(r => WORKSPACE_AREAS.has(r.area));
    this.output.list(rows);
  }

  async get_hub_folders() {
    let hub_id  = this.input.need(Attr.hub_id);
    let node_id = this.input.use(Attr.node_id, null);
    let page    = this.input.use(Attr.page, 1);
    let hub_db  = await this.yp.await_func('get_db_name', hub_id);
    if (!hub_db) return this.output.status('HUB_NOT_FOUND');
    // Use the dedicated single-result-set SP. mfs_show_node_by works for
    // the desk surface but its internal UPDATE/ALTER traffic on temp
    // tables makes the mariadb wrapper here pick the wrong chunk, returning
    // an empty array even when folders exist.
    let res = await this.yp.await_proc(
      `${hub_db}.hub_list_folders`,
      node_id,
      page
    );
    this.output.list(res);
  }

  async get_folder_permissions() {
    let hub_id = this.input.need(Attr.hub_id);
    let nid    = this.input.need(Attr.nid);
    let hub_db = await this.yp.await_func('get_db_name', hub_id);
    if (!hub_db) return this.output.status('HUB_NOT_FOUND');
    // SP returns two SELECTs: first is the config row, second is the
    // member list. The mariadb wrapper picks one chunk and discards the
    // rest — same behaviour we hit on get_hub_folders. Pull both via
    // separate calls so the FE gets a complete payload.
    let cfgRows = toArray(await this.yp.await_proc(
      `${hub_db}.folder_get_permissions`,
      nid
    ));
    let cfg = cfgRows[0] || {};
    let members = toArray(await this.yp.await_proc(
      `${hub_db}.folder_get_member_list`,
      nid
    ));
    this.output.json({
      mode: cfg.mode,
      access: {
        view: !!cfg.access_view,
        edit: !!cfg.access_edit,
        chat: !!cfg.access_chat,
      },
      auto_revoke: !!cfg.auto_revoke,
      auto_revoke_minutes: cfg.auto_revoke_minutes || 30,
      one_time: !!cfg.one_time,
      one_time_url: cfg.one_time_url || '',
      members,
      devices: [],
    });
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