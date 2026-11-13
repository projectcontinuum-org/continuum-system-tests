// credentials-server: /api/v1/credential-types and /api/v1/credentials (CRUD, validation, tenant scoping).
// Each tenant has its own credential namespace; credential types are shared and cannot be deleted.
//   ./run.sh suites/api/credentials.js
import { check } from 'k6';
import { cfg } from '../../lib/config.js';
import { tenant, tenantIds } from '../../lib/tenant.js';
import { knownGap } from '../../lib/checks.js';
import { newRunId, safeJson } from '../../lib/util.js';

export const options = {
  vus: 1,
  iterations: 1,
  thresholds: { checks: ['rate==1'] },
};

const C = '/api/v1/credentials';
const T = '/api/v1/credential-types';

export function setup() {
  const runId = cfg.runId || newRunId();
  const [owner, other] = tenantIds(runId, ['cred', 'cred-other']);
  return { runId, owner, other };
}

export default function (d) {
  const t = tenant(d.owner);
  const o = tenant(d.other);
  const U = cfg.credentials;
  const type = `ctype-${d.runId}`;
  const name = `cred-${d.runId}`;
  const made = [];

  const create = (body, as = t) => as.post(U, C, body, { endpoint: 'cred_create' });
  const valid = { name, type, typeVersion: '1.0.0', data: { user: 'u', secret: 's3cret' }, description: 'system test' };

  try {
    // --- credential types: create, read, conflict, validation
    const tr = t.post(U, T, { type, version: '1.0.0', schema: { fields: ['user', 'secret'] }, uiSchema: {} }, { endpoint: 'ctype_create' });
    const tb = safeJson(tr.body) || {};
    check(tr, {
      'creating a credential type is 201': (r) => r.status === 201,
      'the type echoes its name, version and schema': () => tb.type === type && tb.version === '1.0.0' && !!tb.schema,
      'the type has timestamps': () => !!tb.createdAt && !!tb.updatedAt,
    });
    const dup = t.post(U, T, { type, version: '1.0.0', schema: {}, uiSchema: {} });
    check(dup, { 'a duplicate type+version is 409': (r) => r.status === 409, 'the conflict explains itself': (r) => /already exists/.test((safeJson(r.body) || {}).error || '') });
    check(t.post(U, T, { type: 'bad name!', version: '1.0.0' }), { 'a type name with invalid characters is 400': (r) => r.status === 400 });
    check(t.post(U, T, { type, version: '', schema: {} }), { 'a blank type version is 400': (r) => r.status === 400 });

    const types = safeJson(t.get(U, T).body) || [];
    check(types, {
      'the type list includes the built-in GENERIC type': (l) => l.some((x) => x.type === 'GENERIC'),
      'the type list includes the new type': (l) => l.some((x) => x.type === type),
    });
    check(safeJson(t.get(U, `${T}/${type}`).body) || [], { 'get types by name returns every version': (l) => Array.isArray(l) && l.length === 1 && l[0].version === '1.0.0' });
    check(t.get(U, `${T}/${type}/1.0.0`), { 'get a type by name and version is 200': (r) => r.status === 200 && (safeJson(r.body) || {}).type === type });
    check(t.get(U, `${T}/no-such-type`), { 'an unknown type is 404': (r) => r.status === 404 });
    check(t.get(U, `${T}/${type}/9.9.9`), { 'an unknown type version is 404': (r) => r.status === 404 });
    // Types are shared and permanent: there is no delete.
    check(t.del(U, `${T}/${type}`), { 'deleting a credential type is not supported (405)': (r) => r.status === 405 });

    // --- credentials: create
    const cr = create(valid);
    const cb = safeJson(cr.body) || {};
    if (cr.status === 201) {
      made.push(name);
    }
    check(cr, {
      'creating a credential is 201': (r) => r.status === 201,
      'it echoes name, type, version and description': () => cb.name === name && cb.type === type && cb.typeVersion === '1.0.0' && cb.description === 'system test',
      'it records the caller as owner and creator': () => cb.userId === d.owner && cb.createdBy === d.owner,
      'it has not been accessed yet or reports when': () => cb.lastAccessedAt === null || typeof cb.lastAccessedAt === 'string',
    });
    check(create(valid), { 'a duplicate name for the same tenant is 409': (r) => r.status === 409 });

    // --- credentials: validation
    check(create({ ...valid, name: '../admin' }), { 'a name with path characters is 400': (r) => r.status === 400 });
    check(create({ ...valid, name: 'has space' }), { 'a name with a space is 400': (r) => r.status === 400 });
    check(create({ ...valid, name: 'x'.repeat(256) }), { 'a name over 255 characters is 400': (r) => r.status === 400 });
    check(create({ ...valid, name: `${name}-nodata`, data: {} }), { 'empty data is 400': (r) => r.status === 400 });
    check(create({ ...valid, name: `${name}-notype`, type: 'no-such-type' }), { 'an unknown type is 404': (r) => r.status === 404 });
    check(create({ ...valid, name: `${name}-nover`, typeVersion: '9.9.9' }), { 'an unknown type version is 404': (r) => r.status === 404 });
    // A body that cannot be parsed, or that lacks a required field, is a client error. Today the server's catch-all
    // handler turns the parse failure into a 500 "Internal server error" (the field validators do give 400).
    knownGap('credentials: create with a missing name returns 500, want 400', create({ type, typeVersion: '1.0.0', data: { a: 'b' } }), [400]);
    knownGap('credentials: create with a non-JSON body returns 500, want 400', t.post(U, C, 'garbage'), [400]);

    // --- credentials: read
    const got = t.get(U, `${C}/${name}`, { endpoint: 'cred_get' });
    const gb = safeJson(got.body) || {};
    check(got, {
      'get by name is 200': (r) => r.status === 200,
      'get returns the stored key-value data': () => gb.data && gb.data.user === 'u' && gb.data.secret === 's3cret',
      'reading records lastAccessedAt': () => typeof gb.lastAccessedAt === 'string',
    });
    check(t.get(U, `${C}/no-such-credential`), { 'get of an unknown name is 404': (r) => r.status === 404 });
    check(safeJson(t.get(U, C).body) || [], { 'list contains the credential': (l) => Array.isArray(l) && l.some((c) => c.name === name) });
    check(safeJson(t.get(U, `${C}/type/${type}`).body) || [], { 'list by type finds it': (l) => l.some((c) => c.name === name) });
    check(safeJson(t.get(U, `${C}/type/${type}/1.0.0`).body) || [], { 'list by type and version finds it': (l) => l.some((c) => c.name === name) });
    check(safeJson(t.get(U, `${C}/type/${type}/9.9.9`).body) || [], { 'list by a version that matches nothing is empty': (l) => Array.isArray(l) && l.length === 0 });

    // --- credentials: update. Only the fields sent change.
    const up = t.put(U, `${C}/${name}`, { description: 'changed' }, { endpoint: 'cred_update' });
    const ub = safeJson(up.body) || {};
    check(up, {
      'update is 200': (r) => r.status === 200,
      'the description changed': () => ub.description === 'changed',
      'the data was left untouched': () => ub.data && ub.data.secret === 's3cret',
      'updatedAt moved forward': () => !!ub.updatedAt && ub.updatedAt >= (cb.updatedAt || ''),
    });
    const up2 = safeJson(t.put(U, `${C}/${name}`, { data: { user: 'u2', secret: 'new' } }).body) || {};
    check(up2, { 'the data can be replaced': (c) => c.data && c.data.user === 'u2' && c.data.secret === 'new' });
    check(t.put(U, `${C}/no-such-credential`, { description: 'x' }), { 'update of an unknown name is 404': (r) => r.status === 404 });
    check(t.put(U, `${C}/${name}`, { name: '../admin' }), { 'update to an invalid name is 400': (r) => r.status === 400 });

    // --- the secret is returned in clear to its owner on read (documented behaviour: workers fetch it by name)
    check(safeJson(t.get(U, C).body) || [], { 'the list also returns decrypted data to the owner': (l) => (l.find((c) => c.name === name) || {}).data !== undefined });

    // --- another tenant: its own namespace
    check(o.get(U, `${C}/${name}`), { 'other tenant gets 404 for the credential': (r) => r.status === 404 });
    check(o.put(U, `${C}/${name}`, { description: 'hijack' }), { 'other tenant cannot update it': (r) => r.status === 404 });
    check(o.del(U, `${C}/${name}`), { 'other tenant cannot delete it': (r) => r.status === 404 });
    check(safeJson(o.get(U, C).body) || [], { 'other tenant\'s list is empty': (l) => Array.isArray(l) && l.length === 0 });
    check(safeJson(o.get(U, `${C}/type/${type}`).body) || [], { 'other tenant\'s list by type is empty': (l) => Array.isArray(l) && l.length === 0 });
    // The same name is free in another tenant's namespace, and the two stay independent.
    const sameName = create({ ...valid, data: { who: 'other' } }, o);
    check(sameName, { 'the same name can be created by another tenant': (r) => r.status === 201 });
    check(safeJson(t.get(U, `${C}/${name}`).body) || {}, { 'the first tenant\'s data is unaffected': (c) => c.data && c.data.user === 'u2' });
    check(safeJson(o.get(U, `${C}/${name}`).body) || {}, { 'the other tenant has its own data': (c) => c.data && c.data.who === 'other' });
    o.del(U, `${C}/${name}`);

    // --- delete
    check(t.del(U, `${C}/${name}`), { 'delete is 204': (r) => r.status === 204 });
    made.length = 0;
    check(t.get(U, `${C}/${name}`), { 'a deleted credential is 404': (r) => r.status === 404 });
    check(t.del(U, `${C}/${name}`), { 'deleting it again is 404': (r) => r.status === 404 });
  } finally {
    for (const n of made) {
      t.del(U, `${C}/${n}`);
    }
  }
}
