/**
 * @license
 * Copyright 2024 Thidima SA. All Rights Reserved.
 * Licensed under the GNU AFFERO GENERAL PUBLIC LICENSE, Version 3
 */

/**
 * Pinned workspaces (Lexis, 2026-10-07) -- the server half of the rules in
 * ui-team src/drumee/libs/workspace-pins.js.
 *
 * Stored as `pinned_workspaces` in the user's yp.entity.settings: an array of
 * the desk switcher's row keys, newest pin first -- `hub:<hub_id>` for a hub,
 * `folder:<nid>` for a personal workspace. The FIRST one is the workspace the
 * desk opens when the user enters Drumee.
 *
 * Why the server applies the change instead of storing the list it is sent:
 * the client used to post its whole list, built from the settings it loaded at
 * sign-in. A second device signed in earlier still held the OLD list, and its
 * next pin wrote that old list back -- erasing what the first device had
 * pinned meanwhile. drumate.pinned_workspaces now takes ONE operation and
 * applies it to the list as stored right now, then pushes the result to every
 * open session of the user so each of them is current too.
 *
 * Pure functions: no I/O, so the tests drive the shipped code.
 */

const SETTINGS_KEY = 'pinned_workspaces';
const OPS = ['get', 'pin', 'unpin', 'move'];
// Bounds the settings blob: far beyond any real use, small enough that a
// runaway client cannot grow a user's settings row without limit.
const MAX_PINS = 100;
// A switcher key, nothing else. Same shape the UI accepts; ids are hex.
const KEY_RE = /^(hub|folder):[A-Za-z0-9]{1,64}$/;

function isKey(k) {
  return typeof k === 'string' && KEY_RE.test(k);
}

/**
 * The stored list, cleaned: switcher keys only, first occurrence wins, capped.
 * Anything else -- a missing key, a non-array, junk entries -- reads as empty
 * or is skipped, never thrown on.
 */
function readPins(settings) {
  const raw = settings && settings[SETTINGS_KEY];
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const k of raw) {
    if (!isKey(k) || out.includes(k)) continue;
    out.push(k);
    if (out.length >= MAX_PINS) break;
  }
  return out;
}

/**
 * Validate one request. Returns an error code, or null when it is usable.
 * `before` is only meaningful for `move`; empty / null there means "to the end".
 */
function checkOp(op, key, before) {
  if (!OPS.includes(op)) return 'INVALID_OP';
  if (op === 'get') return null;
  if (!isKey(key)) return 'INVALID_KEY';
  if (op === 'move' && before != null && before !== '' && !isKey(before)) {
    return 'INVALID_KEY';
  }
  return null;
}

/**
 * Apply one operation to `pins`. Never mutates its input.
 *
 *   pin    move/insert `key` to the top (newest first)
 *   unpin  drop `key`
 *   move   put `key` just before `before`, or last when `before` is empty;
 *          an unpinned `key` or an unknown `before` changes nothing
 */
function applyOp(pins, op, key, before) {
  const list = (pins || []).slice();
  switch (op) {
    case 'pin':
      return [key, ...list.filter((k) => k !== key)].slice(0, MAX_PINS);
    case 'unpin':
      return list.filter((k) => k !== key);
    case 'move': {
      if (!list.includes(key) || key === before) return list;
      const rest = list.filter((k) => k !== key);
      if (before == null || before === '') return [...rest, key];
      const i = rest.indexOf(before);
      if (i === -1) return list;
      rest.splice(i, 0, key);
      return rest;
    }
    default:
      return list;
  }
}

function samePins(a, b) {
  return a.length === b.length && a.every((k, i) => k === b[i]);
}

module.exports = {
  SETTINGS_KEY, OPS, MAX_PINS, readPins, checkOp, applyOp, samePins,
};
