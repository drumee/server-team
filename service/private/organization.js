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
    // The ACTING organisation, not home. These endpoints are the org panel:
    // "which departments does it have", "rename it", "move this workspace" --
    // every one of them means the organisation the caller is looking at, and
    // once somebody belongs to two, home stops being that. The router resolved
    // it before this worker ran, from the hub already authorised for the
    // request (or, for the hubless calls, from a membership-checked header),
    // so what arrives here is a domain the caller demonstrably belongs to.
    //
    // Falls back to home, which is what it has always been: with one
    // membership per person the two are the same number, so this changes
    // nothing for any account that exists today.
    const domain_id = ~~(this.user.get('acting_domain_id') || this.user.domain_id());
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
        organisation: null, organisations: [], role: null,
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
    // my_organisations is read for EVERYONE, alongside the header and
    // regardless of `browse`: it lists the organisations this person belongs
    // to, which is their own membership and not the org's inventory. A member
    // who may not see a workspace list may still be told which orgs are theirs.
    //
    // The second argument is the acting domain, which the procedure cannot
    // derive for itself: it used to compute is_current by joining drumate,
    // whose domain_id IS home, so is_current was identically is_home and could
    // never mark an organisation someone had merely joined. Passing
    // org.domain_id keeps today's answer exactly as it was -- acting and home
    // are the same thing until an acting domain is resolved per request -- and
    // gives that resolution one place to land later.
    const reads = [
      this.yp.await_proc('org_summary', org.domain_id),
      this.yp.await_proc('my_organisations', this.uid, org.domain_id),
    ];
    if (org.browse) {
      reads.push(
        this.yp.await_proc('org_departments', org.domain_id),
        this.yp.await_proc('org_workspaces', org.domain_id),
      );
    }
    const [summary, organisations, departments, workspaces] = await Promise.all(reads);

    // await_proc collapses a single-row result to a bare object and answers
    // undefined for an empty one, so a one-department organisation would hand
    // the client an object where it iterates an array and render nothing. Both
    // listings are normalised here, once, rather than in each consumer.
    this.output.data({
      organisation: isEmpty(summary) ? null : summary,
      // Every organisation this person belongs to, each flagged is_current /
      // is_home / is_owner. One entry today; the shape is the contract.
      organisations: this._rows(organisations),
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
