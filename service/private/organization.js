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
const { Attr, Remit } = require("@drumee/server-essentials");

const { stringify } = JSON;
const {isEmpty } = require('lodash');

const {Entity} = require('@drumee/server-core');
const access = require('../lib/department-access');
const ActiveOrg = require('../lib/active-org');
// Extra organisations one person may create (multi-org, Business plan).
const MAX_EXTRA_ORGS = 10;

// Organisation address labels: one DNS label, 2-40 chars, no edge dash.
const IDENT_RE = /^[a-z0-9][a-z0-9-]{0,38}[a-z0-9]$/;
// Subdomains the platform serves itself (nginx server blocks, mail, office,
// conference) or may: an organisation there would be shadowed or confusing.
const RESERVED_IDENTS = new Set([
  'www', 'app', 'api', 'admin', 'auth', 'login', 'signin', 'signup', 'billing',
  'mail', 'dmail', 'webmail', 'smtp', 'imap', 'pop', 'mx', 'ns1', 'ns2',
  'jit', 'meet', 'jitsi', 'turn', 'stun', 'xmpp', 'prosody',
  'oo', 'office', 'euroffice', 'docs', 'cdn', 'static', 'assets',
  'kpi', 'metrics', 'grafana', 'prometheus', 'status', 'monitoring',
  'news', 'blog', 'help', 'support', 'drumee',
  'dev', 'stage', 'staging', 'test', 'uat', 'preview', 'prod', 'demo',
]);
class __private_adminpanel extends Entity {

  // ========================
  // initialize
  // ========================
  constructor(...args) {
    super(...args);

    this.my_subscription = this.my_subscription.bind(this);
    this.my_organisation = this.my_organisation.bind(this);
    this.my_privilege = this.my_privilege.bind(this);

    this.add = this.add.bind(this);
    this.update = this.update.bind(this);
    this.update_password_level = this.update_password_level.bind(this);
    this.update_double_auth = this.update_double_auth.bind(this);
    this.update_dir_visiblity = this.update_dir_visiblity.bind(this);
    this.update_dir_info = this.update_dir_info.bind(this);

    this.overview = this.overview.bind(this);
    this.my_departments = this.my_departments.bind(this);
    this.setup_state = this.setup_state.bind(this);
    this.department_members = this.department_members.bind(this);
    this.department_member_add = this.department_member_add.bind(this);
    this.department_member_remove = this.department_member_remove.bind(this);
    this.department_reconcile = this.department_reconcile.bind(this);
    this.reporting_set = this.reporting_set.bind(this);
    this.join_link_create = this.join_link_create.bind(this);
    this.join_link_revoke = this.join_link_revoke.bind(this);
    this.join_link_accept = this.join_link_accept.bind(this);
    this.setup_done = this.setup_done.bind(this);
    this.rename = this.rename.bind(this);
    this.department_add = this.department_add.bind(this);
    this.department_rename = this.department_rename.bind(this);
    this.department_remove = this.department_remove.bind(this);
    this.department_assign = this.department_assign.bind(this);
  }



  /**
   * 
   */
  async my_privilege() {
    let res = {};
    res.privilege = 0
    let chk = await this.yp.await_proc('my_subscription', this.uid)
    if (!isEmpty(chk)) {
      res.privilege = Remit.dom_owner
    }
    else {
      // chk = await this.yp.await_proc('my_organisation', this.uid)
      chk = await this.user.organization();
      if (!isEmpty(chk)) {
        res.privilege = chk.privilege
      }
    }
    this.output.data(res);
  }

  /**
   * 
   */
  async my_subscription() {
    let res = await this.yp.await_proc('my_subscription', this.uid)
    this.output.data(res);
  }


  /**
   * 
   */
  async my_organisation() {
    let data = await this.user.organization();
    this.output.data(data);
  }

  /**
   * 
   */
  async add() {
    let name = this.input.need(Attr.name);
    let ident = this.input.need(Attr.ident);
    ident = ident.toLowerCase();
    let recds = {};
    let org;
    if (!isEmpty(name)) { recds.name = name }
    if (!isEmpty(ident)) { recds.ident = ident }

    let chk = await this.yp.await_proc('my_subscription', this.uid)
    if (isEmpty(chk)) return this.output.status('INVALID_SUBSCRIPTION');

    chk = await this.user.organization();
    if (!isEmpty(chk)) return this.output.status('ORGANISATION_ALREADY_EXITS');

    chk = await this.yp.await_proc('ident_exists', ident)
    if (!isEmpty(chk)) return this.output.status('IDENT_NOT_AVAILABLE');

    let domain = await this.yp.await_proc('domain_create', ident);
    await this.yp.await_proc('domain_grant', domain.id, Remit.dom_owner, this.uid, 1);
    recds.domain_id = domain.id;
    recds.owner_id = this.id;
    recds.link = domain.name
    org = await this.yp.await_proc('organisation_add', this.uid, name, domain.name, ident, domain.id, stringify(recds));
    this.output.data(org);
  }


  /**
   * 
   * @returns 
   */
  async update() {
    let name = this.input.need(Attr.name);
    let orgid //= this.input.need(Attr.orgid);

    let org = await this.yp.await_proc('organisation_get', this.user.domain_id())
    orgid = org.id;
    if (isEmpty(org)) return this.output.status('NO_ORG');

    let my_org = await this.user.organization();
    if (isEmpty(my_org)) return this.output.status('NO_ORG_TO_UPDATE');
    if (my_org.id != org.id) return this.output.status('INVALID_ORG');

    let my_privilege = await this.yp.await_proc('domain_privilege', my_org.domain_id, this.uid);
    if (my_privilege.privilege < Remit.dom_admin) return this.output.status('NOT_ENOUGH_PRIVILEGE');

    let domain = await this.yp.await_proc('domain_update', org.ident, org.domain_id);
    let link = domain.name.replace(/^http.*:\/\//, '');

    org = await this.yp.await_proc('organisation_update', this.uid, orgid, name, link, org.ident);
    this.output.data(org);
  }

  /**
   * 
   * @returns 
   */
  async update_password_level() {
    let option = this.input.need(Attr.option);
    let orgid //= this.input.need(Attr.orgid);
    let org = await this.yp.await_proc('organisation_get', this.user.domain_id())
    orgid = org.id;
    if (isEmpty(org)) return this.output.status('NO_ORG');

    // let my_org = await this.yp.await_proc('my_organisation', this.uid)
    let my_org = await this.user.organization();
    if (isEmpty(my_org)) return this.output.status('NO_ORG_TO_UPDATE');

    if (my_org.id != org.id) return this.output.status('INVALID_ORG');

    let my_privilege = await this.yp.await_proc('domain_privilege', my_org.domain_id, this.uid);
    if (my_privilege.privilege < Remit.dom_admin_security) return this.output.status('NOT_ENOUGH_PRIVILEGE');

    org = await this.yp.await_proc('organisation_update_password_level', this.uid, orgid, option);
    this.output.data(org);
  }

  /**
   * 
   * @returns 
   */
  async update_double_auth() {
    let option = this.input.need(Attr.option);
    let orgid //= this.input.need(Attr.orgid);
    let org = await this.yp.await_proc('organisation_get', this.user.domain_id())
    orgid = org.id;
    if (isEmpty(org)) return this.output.status('NO_ORG');

    let my_org = await this.user.organization();
    if (isEmpty(my_org)) return this.output.status('NO_ORG_TO_UPDATE');

    if (my_org.id != org.id) return this.output.status('INVALID_ORG');

    let my_privilege = await this.yp.await_proc('domain_privilege', my_org.domain_id, this.uid);
    if (my_privilege.privilege < Remit.dom_admin_security) return this.output.status('NOT_ENOUGH_PRIVILEGE');

    org = await this.yp.await_proc('organisation_update_double_auth', this.uid, orgid, option);
    this.output.data(org);
  }


  /**
   * 
   * @returns 
   */
  async update_dir_visiblity() {
    let option = this.input.need(Attr.option);
    let orgid //= this.input.need(Attr.orgid);
    let org = await this.yp.await_proc('organisation_get', this.user.domain_id())
    orgid = org.id;
    if (isEmpty(org)) return this.output.status('NO_ORG');

    let my_org = await this.user.organization();
    if (isEmpty(my_org)) return this.output.status('NO_ORG_TO_UPDATE');

    if (my_org.id != org.id) return this.output.status('INVALID_ORG');

    let my_privilege = await this.yp.await_proc('domain_privilege', my_org.domain_id, this.uid);
    if (my_privilege.privilege < Remit.dom_admin_security) return this.output.status('NOT_ENOUGH_PRIVILEGE');

    org = await this.yp.await_proc('organisation_update_dir_visiblity', this.uid, orgid, option);
    this.output.data(org);
  }


  /**
   * 
   * @returns 
   */
  async update_dir_info() {
    let option = this.input.need(Attr.option);
    let orgid //= this.input.need(Attr.orgid);

    let org = await this.yp.await_proc('organisation_get', this.user.domain_id())
    orgid = org.id;
    if (isEmpty(org)) return this.output.status('NO_ORG');

    let my_org = await this.user.organization();
    if (isEmpty(my_org)) return this.output.status('NO_ORG_TO_UPDATE');

    if (my_org.id != org.id) return this.output.status('INVALID_ORG');

    let my_privilege = await this.yp.await_proc('domain_privilege', my_org.domain_id, this.uid);
    if (my_privilege.privilege < Remit.dom_admin_security) return this.output.status('NOT_ENOUGH_PRIVILEGE');

    org = await this.yp.await_proc('organisation_update_dir_info', this.uid, orgid, option);
    this.output.data(org);
  }



  // =======================================================================
  // Departments and the org view (Figma 104:33055)
  // =======================================================================

  /**
   * The caller's organisation, or null when they are still on the default
   * public domain (domain 1) and therefore have no organisation at all.
   *
   * Every endpoint below needs the SAME two facts -- which domain, and may the
   * caller write to it -- so they are resolved once here rather than repeated
   * five times with five chances to drift apart. `write` follows the tier
   * ladder the rest of this worker already uses (organisation.update and
   * friends compare against Remit.dom_admin through domain_privilege), so a
   * department is editable by exactly the people who can rename the
   * organisation.
   *
   * @returns {Promise<Object|null>} { domain_id, write } or null
   */
  async _org() {
    const domain_id = ~~this.user.domain_id();
    if (domain_id <= 1) return null;
    const priv = await this.yp.await_proc('domain_privilege', domain_id, this.uid);
    const privilege = ~~(priv && priv.privilege);
    return {
      domain_id,
      privilege,
      // WRITES -- rename the org, add/rename/remove/assign departments.
      write: privilege >= Remit.dom_admin,
      // THE ORG VIEW -- the department tree and the workspace inventory.
      //
      // A LOWER BAR THAN WRITES, and deliberately the same bar as the "admin"
      // label below, so a panel that calls you an admin never then refuses to
      // open. dom_admin_security (15) administers the organisation without
      // holding dom_admin (31), and reading the map of it is squarely within
      // that.
      browse: privilege >= Remit.dom_admin_security,
      role: this._role(privilege),
    };
  }

  /**
   * The viewer's role, as three words rather than six tiers.
   *
   * yp.privilege runs a six-step Remit ladder (63/31/15/7/3/1) that means
   * nothing to a reader, and four of those steps have one person or fewer on a
   * live install. Owner / Admin / Member is what the panel says.
   *
   * The boundaries are chosen so the label never over-promises: "admin" starts
   * at exactly the tier that can open the org view (see browse above), and
   * everything below it -- including a privilege of 0, which is real in the
   * data and is not the same as dom_member -- reads as "member". A person with
   * no privilege row at all never gets here: _org() returns null for them.
   *
   * @param {Number} privilege
   * @returns {String} 'owner' | 'admin' | 'member'
   */
  _role(privilege) {
    if (privilege >= Remit.dom_owner) return 'owner';
    if (privilege >= Remit.dom_admin_security) return 'admin';
    return 'member';
  }

  /**
   * Everything the org view and the org dropdown draw, in one call.
   *
   * ONE ROUND TRIP, THREE RESULT SETS. The screen is a single render -- header
   * counts, department sections, workspace cards -- and splitting it into three
   * endpoints would let the client paint a department whose workspaces have not
   * arrived, or a count that disagrees with the grid beneath it.
   *
   * READ-OPEN TO ANY MEMBER. The dropdown that consumes this is in the top bar
   * of every session, so gating it on admin would leave ordinary members with a
   * chip that never fills in. Nothing here is privileged: names and counts of
   * workspaces inside your own organisation, which the member directory already
   * exposes. The MUTATIONS below are admin-only.
   *
   * `can_manage` is returned rather than inferred client-side so the dropdown's
   * rename pencil, "New department" and "New workspace" affordances are decided
   * by the same privilege read that would refuse the write.
   */
  async overview() {
    const org = await this._org();
    if (!org) {
      return this.output.data({
        organisation: null, role: null,
        departments: [], workspaces: [], can_manage: 0, can_browse: 0,
      });
    }

    // THE HEADER IS FOR EVERYONE; THE INVENTORY IS NOT.
    //
    // org_summary is aggregate -- the org's name, its address, and three
    // COUNTS. Any member may see that: it is their own organisation, and the
    // member directory already tells them how many of them there are.
    //
    // org_departments and org_workspaces are the opposite. Both are scoped by
    // domain_id and by nothing else, so they carry the NAME, member count and
    // grouping of every workspace in the organisation -- including private
    // ones the caller cannot open. Handing those to a plain member disclosed a
    // list they have no access to and could not act on: clicking one refuses
    // at media.attributes, so the name leaked and the access still failed.
    //
    // Filtering them per caller is the alternative and it is not cheap:
    // per-workspace membership is not in yp at all, it is a permission row
    // inside each hub's OWN database (which is why yp.workspace_members exists
    // as a count-only rollup). Withholding the two lists costs a member
    // nothing they could use, and needs no membership index.
    const reads = [this.yp.await_proc('org_summary', org.domain_id)];
    if (org.browse) {
      reads.push(
        this.yp.await_proc('org_departments', org.domain_id),
        this.yp.await_proc('org_workspaces', org.domain_id),
      );
    }
    const [summary, departments, workspaces] = await Promise.all(reads);

    // await_proc collapses a single-row result to a bare object and answers
    // undefined for an empty one, so a one-department organisation would hand
    // the client an object where it iterates an array and render nothing. Both
    // listings are normalised here, once, rather than in each consumer.
    this.output.data({
      organisation: isEmpty(summary) ? null : summary,
      role: org.role,
      departments: this._rows(departments),
      workspaces: this._rows(workspaces),
      can_manage: org.write ? 1 : 0,
      // Whether the client should offer "Open" at all. Reported rather than
      // inferred from an empty list: "no departments yet" and "not allowed to
      // see the departments" are different states and must not render alike.
      can_browse: org.browse ? 1 : 0,
    });
  }

  /**
   * The departments the caller can see, each carrying its workspaces — what
   * the topbar's "Department-name v" crumb and the department-scoped
   * workspace switcher draw.
   *
   * TWO SOURCES, ONE SHAPE. An admin (browse) gets the organisation's whole
   * inventory, exactly what overview already hands them, regrouped. Anyone
   * else gets yp.my_departments: only the departments they have a workspace
   * in, and only those workspaces, read from their OWN membership. The crumb
   * is shown to every member, so it cannot use the inventory -- that is the
   * disclosure overview's header describes -- and it cannot leave members
   * without a crumb either.
   *
   * Ungrouped workspaces are dropped: they have no department to draw.
   */
  async my_departments() {
    const org = await this._org();
    if (!org) return this.output.data({ departments: [], can_manage: 0 });

    let departments = [];
    let workspaces = [];
    if (org.browse) {
      const [d, w] = await Promise.all([
        this.yp.await_proc('org_departments', org.domain_id),
        this.yp.await_proc('org_workspaces', org.domain_id),
      ]);
      departments = this._rows(d);
      workspaces = this._rows(w);
    } else {
      workspaces = this._rows(
        await this.yp.await_proc('my_departments', this.uid, org.domain_id),
      );
      // Departments in the order the proc returned their workspaces, which is
      // rank order -- the same order org_departments uses.
      const seen = new Map();
      for (const w of workspaces) {
        if (!seen.has(w.department_id)) {
          seen.set(w.department_id, {
            id: w.department_id,
            name: w.department_name,
            rank: w.department_rank,
          });
        }
      }
      departments = [...seen.values()];
    }

    const byDept = new Map(departments.map((d) => [d.id, { ...d, workspaces: [] }]));
    for (const w of workspaces) {
      const d = w.department_id && byDept.get(w.department_id);
      if (d) d.workspaces.push(w);
    }
    this.output.data({
      departments: [...byDept.values()],
      can_manage: org.write ? 1 : 0,
    });
  }

  /**
   * Setup wizard state — B2B Org Structure "Set up your organization".
   *
   * Read by the desk on every home settle, so it is one cheap proc and open
   * to any member; whether to OFFER the wizard (owner only, no departments,
   * never finished) is decided client-side from what this returns. Outside an
   * organisation there is nothing to set up, reported as done.
   */
  async setup_state() {
    const org = await this._org();
    if (!org) {
      return this.output.data({ setup_done: 1, department_count: 0, role: null, can_manage: 0 });
    }
    const row = (await this.yp.await_proc('org_setup_state', org.domain_id)) || {};
    this.output.data({
      setup_done: ~~row.setup_done,
      department_count: ~~row.department_count,
      role: org.role,
      can_manage: org.write ? 1 : 0,
    });
  }

  /**
   * The wizard was finished or skipped: stop offering it. Admin-only, like
   * every other write here.
   */
  async setup_done() {
    const org = await this._org();
    if (!org) return this.output.status('NOT_IN_ORGANISATION');
    if (!org.write) return this.output.status('NOT_ENOUGH_PRIVILEGE');
    const res = await this.yp.await_proc('org_setup_mark', org.domain_id);
    this.output.data(res || {});
  }

  // ── Department members + department access (B2B Org Structure) ────────

  /**
   * Who belongs to which department: {members: [{department_id, uid}]}.
   * Org admins only (the same browse bar as the org view's inventory).
   */
  async department_members() {
    const org = await this._org();
    if (!org) return this.output.status('NOT_IN_ORGANISATION');
    if (!org.browse) return this.output.status('NOT_ENOUGH_PRIVILEGE');
    const rows = this._rows(await this.yp.await_proc('department_member_list', org.domain_id));
    this.output.data({ members: rows });
  }

  /**
   * Put a person in a department, then apply department access.
   */
  async department_member_add() {
    const org = await this._org();
    if (!org) return this.output.status('NOT_IN_ORGANISATION');
    if (!org.write) return this.output.status('NOT_ENOUGH_PRIVILEGE');
    const dept = String(this.input.need('department_id') || '').trim();
    const uid = String(this.input.need(Attr.uid) || '').trim();
    if (!/^[0-9a-f]{16}$/i.test(uid)) return this.output.status('NOT_VALID_DRUMATE');
    const res = await this.yp.await_proc('department_member_add', org.domain_id, dept, uid, this.uid);
    if (this._refused(res)) return;
    const summary = await this._reconcile(org.domain_id);
    this.output.data({ department_id: dept, uid, ...summary });
  }

  /**
   * Take a person out of a department, then take back what it granted.
   */
  async department_member_remove() {
    const org = await this._org();
    if (!org) return this.output.status('NOT_IN_ORGANISATION');
    if (!org.write) return this.output.status('NOT_ENOUGH_PRIVILEGE');
    const dept = String(this.input.need('department_id') || '').trim();
    const uid = String(this.input.need(Attr.uid) || '').trim();
    await this.yp.await_proc('department_member_remove', org.domain_id, dept, uid);
    const summary = await this._reconcile(org.domain_id);
    this.output.data({ department_id: dept, uid, ...summary });
  }

  /**
   * Re-apply department access for the whole organisation — after a title,
   * an access rule or a workspace's department changed. Idempotent.
   */
  async department_reconcile() {
    const org = await this._org();
    if (!org) return this.output.status('NOT_IN_ORGANISATION');
    if (!org.write) return this.output.status('NOT_ENOUGH_PRIVILEGE');
    this.output.data(await this._reconcile(org.domain_id));
  }

  /**
   * A person's privilege in a workspace, read from the hub's own database
   * (the '*' row every access check reads). 0 when not a member.
   */
  async _hubPrivilege(hubDb, uid) {
    if (!hubDb || !/^[A-Za-z0-9_]+$/.test(String(hubDb))) return 0;
    const rows = this._rows(await this.yp.await_query(
      `SELECT permission FROM \`${hubDb}\`.permission WHERE resource_id = '*' AND entity_id = ? LIMIT 1`,
      uid,
    ));
    return rows.length ? ~~rows[0].permission : 0;
  }

  /**
   * Make department access match department membership, titles and rules:
   * grant what is missing, take back what is no longer given (see
   * service/lib/department-access.js for the rules). Never throws: a
   * workspace that cannot be written is counted, not fatal.
   */
  async _reconcile(domain_id) {
    const summary = { granted: 0, updated: 0, revoked: 0, failed: 0 };
    const stored = this._rows(await this.yp.await_proc('organisation_get_access_rules', domain_id))[0];
    const rules = access.rulesByTitle(stored && stored.access_rules);
    const desired = access.desiredGrants(
      await this.yp.await_proc('department_desired_grants', domain_id), rules,
    );
    const existing = new Map();
    for (const g of this._rows(await this.yp.await_proc('department_grant_list', domain_id))) {
      existing.set(`${g.hub_id}|${g.uid}`, g);
    }
    const grant = (uid, hub_id, privilege) => this.yp.await_proc(
      'member_save_workspace_roles', uid, JSON.stringify([{ hub_id, privilege }]),
    );
    const touched = new Set();

    for (const [key, d] of desired) {
      try {
        const cur = await this._hubPrivilege(d.hub_db, d.uid);
        const ex = existing.get(key);
        const plan = access.planGrant(d, cur, ex);
        if (plan.write) {
          await grant(d.uid, d.hub_id, plan.write);
          touched.add(d.hub_id);
          ex ? summary.updated++ : summary.granted++;
        }
        if (plan.save) {
          await this.yp.await_proc(
            'department_grant_save', domain_id, d.hub_id, d.uid, plan.save.privilege, plan.save.prev,
          );
        }
      } catch (e) {
        summary.failed++;
      }
    }

    for (const [key, ex] of existing) {
      if (desired.has(key)) continue;
      try {
        const cur = await this._hubPrivilege(ex.hub_db, ex.uid);
        const what = access.planRevoke(ex, cur);
        if (what === 'remove') {
          await this.yp.await_proc(`${ex.hub_db}.hub_member_remove`, ex.uid, this.uid);
          touched.add(ex.hub_id);
          summary.revoked++;
        } else if (what === 'restore') {
          await grant(ex.uid, ex.hub_id, ~~ex.prev_privilege);
          summary.revoked++;
        }
        await this.yp.await_proc('department_grant_delete', ex.hub_id, ex.uid);
      } catch (e) {
        summary.failed++;
      }
    }

    // The member-count rollup the org view reads; never fatal.
    for (const hub_id of touched) {
      await this.yp.await_proc('workspace_members_set', hub_id).catch(() => null);
    }
    return summary;
  }

  // ── Org chart reporting lines ──────────────────────────────────────────

  /**
   * Set who a person reports to (manager_uid), or clear it (''). Refuses a
   * line that would make someone their own manager.
   */
  async reporting_set() {
    const org = await this._org();
    if (!org) return this.output.status('NOT_IN_ORGANISATION');
    if (!org.write) return this.output.status('NOT_ENOUGH_PRIVILEGE');
    const uid = String(this.input.need(Attr.uid) || '').trim();
    const manager = String(this.input.use('manager_uid', '') || '').trim();
    if (!/^[0-9a-f]{16}$/i.test(uid)) return this.output.status('NOT_VALID_DRUMATE');
    if (manager && !/^[0-9a-f]{16}$/i.test(manager)) return this.output.status('NOT_VALID_DRUMATE');
    const lines = this._rows(await this.yp.await_proc('org_reporting_list', org.domain_id));
    if (access.makesCycle(lines, uid, manager)) return this.output.status('REPORTING_CYCLE');
    const res = await this.yp.await_proc('org_reporting_set', org.domain_id, uid, manager || null);
    this.output.data(res || {});
  }

  // ── Department join links (setup wizard "Public link") ─────────────────

  /**
   * Mint a link that puts whoever opens it into the workspaces of the given
   * departments. expires_in is seconds (0 = never).
   */
  async join_link_create() {
    const org = await this._org();
    if (!org) return this.output.status('NOT_IN_ORGANISATION');
    if (!org.write) return this.output.status('NOT_ENOUGH_PRIVILEGE');
    let departments = this.input.need('departments');
    if (typeof departments === 'string') {
      try { departments = JSON.parse(departments); } catch (e) { departments = [departments]; }
    }
    departments = this._rows(departments).map(String).filter(Boolean);
    if (!departments.length) return this.output.status('INVALID_DEPARTMENTS');
    const known = new Set(this._rows(await this.yp.await_proc('org_departments', org.domain_id)).map((d) => String(d.id)));
    if (departments.some((d) => !known.has(d))) return this.output.status('DEPARTMENT_NOT_FOUND');
    const seconds = Math.max(0, ~~this.input.use('expires_in', 0));
    const expires_at = seconds ? Math.floor(Date.now() / 1000) + seconds : 0;
    const res = await this.yp.await_proc(
      'org_join_link_add', org.domain_id, JSON.stringify(departments), access.PRIVILEGE.view, expires_at, this.uid,
    );
    if (this._refused(res)) return;
    this.output.data({ token: res.id, expires_at });
  }

  async join_link_revoke() {
    const org = await this._org();
    if (!org) return this.output.status('NOT_IN_ORGANISATION');
    if (!org.write) return this.output.status('NOT_ENOUGH_PRIVILEGE');
    const token = String(this.input.need('token') || '').trim();
    const res = await this.yp.await_proc('org_join_link_revoke', org.domain_id, token);
    this.output.data(res || {});
  }

  /**
   * Open a join link: the signed-in caller joins the link's departments and
   * gets department access to their workspaces — the link's whole purpose is
   * to reach people the owner has no email for.
   *
   * WORKSPACE ACCESS, NOT ORGANISATION MEMBERSHIP. Someone from outside the
   * organisation becomes a collaborator of its workspaces, the way an
   * accepted workspace invitation makes them one; moving them INTO the
   * organisation is multi-org, which this does not do.
   */
  async join_link_accept() {
    const token = String(this.input.need('token') || '').trim();
    const link = this._rows(await this.yp.await_proc('org_join_link_get', token))[0];
    if (!link) return this.output.status('LINK_NOT_FOUND');
    if (!~~link.usable) return this.output.status('LINK_EXPIRED');
    const domain_id = ~~link.domain_id;
    let departments = [];
    try { departments = JSON.parse(link.departments); } catch (e) { departments = []; }
    for (const d of this._rows(departments)) {
      await this.yp.await_proc('department_member_add', domain_id, String(d), this.uid, link.by_id || this.uid);
    }
    // Multi-org: someone from another organisation (or none) joins this one
    // as a secondary organisation. The primary one is never touched.
    let org_link = null;
    const home = ~~(this.user.get('home_domain_id') || this.user.domain_id());
    if (home !== domain_id) {
      const m = await this.yp.await_proc('org_membership_set', domain_id, this.uid, Remit.dom_member, link.by_id || null);
      if (m && !m.error) {
        ActiveOrg.forget(this.uid, domain_id);
        const org = this._rows(await this.yp.await_proc('organisation_get', domain_id))[0];
        org_link = org ? org.link : null;
      }
    }
    await this.yp.await_proc('org_join_link_use', token);
    const summary = await this._reconcile(domain_id);
    this.output.data({ joined: departments.length, org_link, ...summary });
  }

  /**
   * Normalise an await_proc result to an array.
   *
   * A list procedure that matched exactly one row answers `{...}` and one that
   * matched none answers undefined -- only two or more rows come back as
   * `[{...}]`. `Array.isArray(x) ? x : []` is the tempting shape and is wrong:
   * it silently empties the UI for every organisation with a single department.
   *
   * @param {Object|Array|undefined} rows
   * @returns {Array}
   */
  _rows(rows) {
    if (isEmpty(rows)) return [];
    return Array.isArray(rows) ? rows : [rows];
  }

  /**
   * Map a procedure's single-column `error` result onto an output status.
   *
   * The department procedures report refusals as a result row rather than by
   * SIGNAL, so that a refusal (name taken, wrong tenant) is distinguishable
   * from a genuine SQL fault -- which still throws and still reaches the
   * caller as a 500. Returns true when it consumed the result.
   *
   * @param {Object} res
   * @returns {Boolean}
   */
  _refused(res) {
    if (res && res.error) {
      this.output.status(res.error);
      return true;
    }
    return false;
  }

  /**
   * Rename the organisation — the pencil beside its name in the org dropdown.
   *
   * DELIBERATELY NOT `update()`. That method renames the DOMAIN too: it calls
   * domain_update(org.ident, org.domain_id), which rewrites yp.domain.name to
   * `<ident>.<main_domain>`. On a healthy row that rewrite is a no-op because
   * the ident it feeds back is the one already there -- but on a row whose
   * ident is NULL it writes the literal "null.<main_domain>" over the
   * organisation's address, and an address is not what a pencil next to a
   * display name offers to change. This touches `name` and nothing else:
   * link and ident are read back and written unchanged, because
   * organisation_update takes all three.
   *
   * Same admin gate as the department mutations -- an organisation's label is
   * at least as consequential as a department's.
   */
  async rename() {
    const org = await this._org();
    if (!org) return this.output.status('NOT_IN_ORGANISATION');
    if (!org.write) return this.output.status('NOT_ENOUGH_PRIVILEGE');

    const name = String(this.input.need(Attr.name) || '').trim();
    if (!name) return this.output.status('INVALID_NAME');

    const row = await this.yp.await_proc('organisation_get', org.domain_id);
    if (isEmpty(row)) return this.output.status('NO_ORG');

    const res = await this.yp.await_proc(
      'organisation_update', this.uid, row.id, name, row.link, row.ident,
    );
    this.output.data(res);
  }

  // ── Multi-org (Figma 900:150849 / 900:150993) ────────────────────────

  /**
   * Every organisation the person belongs to, for the org dropdown:
   *   owned:   privilege 63 (their first organisation, extra ones);
   *   invited: anything else -- member/admin of another organisation, or a
   *            guest holding workspaces there.
   * Each row: {domain_id, org_id, name, link, plan, role, privilege, source,
   * department_count, member_count, current}. Plus can_create_org (Business
   * plan) and the primary plan for the Free/Team upsell.
   */
  async my_orgs() {
    const uid = this.uid;
    const hostDom = ~~this.hub.get('org_id');
    const list = this._rows(await this.yp.await_proc('my_orgs', uid));
    const seen = new Set(list.map((o) => ~~o.domain_id));

    // Guests: organisations where the person holds workspaces but no seat.
    const db = this.user.get('db_name');
    if (db && /^[0-9a-zA-Z_]+$/.test(db)) {
      const guest = this._rows(await this.yp.await_query(
        `SELECT DISTINCT o.id AS org_id, o.domain_id, o.name, o.link, o.ident, ` +
        `(SELECT q.plan FROM quota q WHERE q.domain_id = o.domain_id AND q.payer_id = o.id LIMIT 1) AS plan ` +
        `FROM \`${db}\`.media m INNER JOIN yp.entity e ON e.id = m.id ` +
        `INNER JOIN yp.organisation o ON o.domain_id = e.dom_id ` +
        `WHERE m.category = 'hub' AND m.extension <> 'dmz' AND e.dom_id > 1`,
      ));
      for (const g of guest) {
        if (seen.has(~~g.domain_id)) continue;
        seen.add(~~g.domain_id);
        list.push({ ...g, privilege: 0, source: 'guest', department_count: null, member_count: null });
      }
    }

    const quota = this._rows(await this.yp.await_query(
      "SELECT JSON_VALUE(get_quota(?), '$.plan') AS plan", uid,
    ))[0] || {};
    const primary_plan = String(quota.plan || 'free');
    const orgs = list.map((o) => {
      const privilege = ~~o.privilege;
      const role = o.source === 'guest' ? 'guest' : this._role(privilege);
      return {
        domain_id: ~~o.domain_id,
        org_id: o.org_id,
        name: o.name,
        link: o.link,
        plan: o.plan || null,
        privilege,
        role,
        source: o.source,
        owned: privilege >= Remit.dom_owner ? 1 : 0,
        department_count: o.department_count == null ? null : ~~o.department_count,
        member_count: o.member_count == null ? null : ~~o.member_count,
        current: ~~o.domain_id === hostDom ? 1 : 0,
      };
    });
    this.output.data({
      orgs,
      primary_plan,
      can_create_org: /^business/i.test(primary_plan) ? 1 : 0,
    });
  }

  /**
   * "+ New organization" (Business plan): one more organisation owned by the
   * caller, who stays in their first one (org_extra_create). Returns the new
   * organisation with its link, for the client to open.
   */
  async create_org() {
    const quota = this._rows(await this.yp.await_query(
      "SELECT JSON_VALUE(get_quota(?), '$.plan') AS plan", this.uid,
    ))[0] || {};
    if (!/^business/i.test(String(quota.plan || ''))) return this.output.status('PLAN_UPGRADE_REQUIRED');
    const owned = this._rows(await this.yp.await_query(
      'SELECT COUNT(*) AS n FROM org_extra WHERE owner_uid = ?', this.uid,
    ))[0] || {};
    if (~~owned.n >= MAX_EXTRA_ORGS) return this.output.status('TOO_MANY_ORGANISATIONS');

    const name = String(this.input.need(Attr.name) || '').trim();
    if (!name || name.length > 512) return this.output.status('INVALID_NAME');
    const ident = String(this.input.need(Attr.ident) || '').trim().toLowerCase();
    if (!IDENT_RE.test(ident)) return this.output.status('INVALID_IDENT');
    if (RESERVED_IDENTS.has(ident)) return this.output.status('IDENT_RESERVED');

    const res = await this.yp.await_proc('org_extra_create', this.uid, name, ident);
    if (this._refused(res)) return;
    ActiveOrg.forget(this.uid);
    this.output.data(res || {});
  }

  /**
   * Add someone who already has a Drumee account elsewhere to MY current
   * organisation as a secondary organisation (by email). Org admins only.
   */
  async member_add_existing() {
    const org = await this._org();
    if (!org) return this.output.status('NOT_IN_ORGANISATION');
    if (!org.write) return this.output.status('NOT_ENOUGH_PRIVILEGE');
    const email = String(this.input.need('email') || '').trim().toLowerCase();
    const person = this._rows(await this.yp.await_query(
      'SELECT id FROM drumate WHERE email = ? LIMIT 1', email,
    ))[0];
    if (!person) return this.output.status('USER_NOT_FOUND');
    let privilege = ~~this.input.get('privilege') || Remit.dom_member;
    if (privilege >= Remit.dom_owner && org.role !== 'owner') privilege = Remit.dom_admin;
    const res = await this.yp.await_proc('org_membership_set', org.domain_id, person.id, privilege, this.uid);
    if (this._refused(res)) return;
    ActiveOrg.forget(person.id, org.domain_id);
    this.output.data(res || {});
  }

  /**
   * Take someone out of MY current organisation when it is their secondary
   * one. Org admins only; nobody can remove the organisation's owner.
   */
  async member_remove_existing() {
    const org = await this._org();
    if (!org) return this.output.status('NOT_IN_ORGANISATION');
    if (!org.write) return this.output.status('NOT_ENOUGH_PRIVILEGE');
    const uid = String(this.input.need(Attr.uid) || '').trim();
    const cur = this._rows(await this.yp.await_proc('org_membership_get', uid, org.domain_id))[0];
    if (!cur) return this.output.status('NOT_A_MEMBER');
    if (~~cur.privilege >= Remit.dom_owner && org.role !== 'owner') return this.output.status('NOT_ENOUGH_PRIVILEGE');
    const res = await this.yp.await_proc('org_membership_remove', org.domain_id, uid);
    ActiveOrg.forget(uid, org.domain_id);
    this.output.data(res || {});
  }

  /**
   * People who belong to MY current organisation as a secondary one.
   */
  async members_existing() {
    const org = await this._org();
    if (!org) return this.output.status('NOT_IN_ORGANISATION');
    if (!org.browse) return this.output.status('NOT_ENOUGH_PRIVILEGE');
    this.output.data({ members: this._rows(await this.yp.await_proc('org_membership_list', org.domain_id)) });
  }

  // ── Organisation address (setup wizard "Custom domain") ──────────────

  /**
   * Validate an address label and run organisation_change_ident, dry or not.
   * Owner only: moving the address changes every member's URL.
   */
  async _changeIdent(dry) {
    const org = await this._org();
    if (!org) return this.output.status('NOT_IN_ORGANISATION');
    if (org.role !== 'owner') return this.output.status('NOT_ENOUGH_PRIVILEGE');
    const ident = String(this.input.need(Attr.ident) || '').trim().toLowerCase();
    if (!IDENT_RE.test(ident)) return this.output.status('INVALID_IDENT');
    if (RESERVED_IDENTS.has(ident)) return this.output.status('IDENT_RESERVED');
    const res = await this.yp.await_proc('organisation_change_ident', org.domain_id, ident, dry ? 1 : 0);
    if (this._refused(res)) return;
    this.output.data(res || {});
  }

  /**
   * Is this address label free for my organisation? No write.
   */
  async ident_check() {
    return this._changeIdent(true);
  }

  /**
   * Move my organisation to <ident>.<main_domain>.
   */
  async change_ident() {
    return this._changeIdent(false);
  }

  /**
   * Create a department. Admin-only; see _org().
   */
  async department_add() {
    const org = await this._org();
    if (!org) return this.output.status('NOT_IN_ORGANISATION');
    if (!org.write) return this.output.status('NOT_ENOUGH_PRIVILEGE');

    const name = String(this.input.need(Attr.name) || '').trim();
    const res = await this.yp.await_proc('department_add', org.domain_id, this.uid, name);
    if (this._refused(res)) return;
    this.output.data(res);
  }

  /**
   * Rename a department. Admin-only; see _org().
   */
  async department_rename() {
    const org = await this._org();
    if (!org) return this.output.status('NOT_IN_ORGANISATION');
    if (!org.write) return this.output.status('NOT_ENOUGH_PRIVILEGE');

    const id = String(this.input.need('department_id') || '').trim();
    const name = String(this.input.need(Attr.name) || '').trim();
    const res = await this.yp.await_proc('department_rename', org.domain_id, id, name);
    if (this._refused(res)) return;
    this.output.data(res);
  }

  /**
   * Delete a department. Admin-only; see _org().
   *
   * Its workspaces are NOT deleted -- department_remove unsets their
   * department_id and they reappear in the org view's ungrouped row. The
   * response carries how many moved so the client can say so.
   */
  async department_remove() {
    const org = await this._org();
    if (!org) return this.output.status('NOT_IN_ORGANISATION');
    if (!org.write) return this.output.status('NOT_ENOUGH_PRIVILEGE');

    const id = String(this.input.need('department_id') || '').trim();
    const res = await this.yp.await_proc('department_remove', org.domain_id, id);
    if (this._refused(res)) return;
    this.output.data(res);
  }

  /**
   * Move a workspace into a department, or out of all of them.
   *
   * An empty / absent department_id means "ungrouped" and is a legitimate
   * target, not a missing argument -- it is how a workspace leaves a department
   * without the department being deleted. Hence `use`, not `need`.
   *
   * THE WORKSPACE ARRIVES AS `nid`, NOT `hub_id`. Every service here is
   * ADDRESSED with hub_id -- it is the session's hub context, which the ACL
   * reads to resolve scope -- so a service acting on a DIFFERENT hub carries it
   * under its own key. desk.leave_hub sets the precedent (nid = the hub being
   * left, hub_id = the caller's own); reusing hub_id for the target would move
   * the ACL context to the workspace being edited.
   */
  async department_assign() {
    const org = await this._org();
    if (!org) return this.output.status('NOT_IN_ORGANISATION');
    if (!org.write) return this.output.status('NOT_ENOUGH_PRIVILEGE');

    const hub_id = String(this.input.need(Attr.nid) || '').trim();
    const dept = String(this.input.use('department_id', '') || '').trim();
    const res = await this.yp.await_proc(
      'department_assign', org.domain_id, hub_id, dept || null,
    );
    if (this._refused(res)) return;
    this.output.data(res);
  }

}


module.exports = __private_adminpanel;
