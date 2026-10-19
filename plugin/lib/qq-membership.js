// Membership data is a set of parallel entitlements, not a single product enum.
// Preserve only membership fields, never the complete login response.
export const MEMBERSHIP_VERSION = 4
const identityKeys = ['vip', 'HugeVip', 'svip', 'level', 'nextlevel', 'overdate', 'yearflag',
  'eight', 'eightEnd', 'twelve', 'twelveEnd', 'HugeVipStart', 'HugeVipEnd']
const integer = value => {
  if (typeof value === 'boolean') return Number(value)
  if (typeof value !== 'number' && !(typeof value === 'string' && /^[+-]?\d+$/.test(value.trim()))) return null
  const n = Number(value)
  return Number.isSafeInteger(n) ? n : null
}
const nonzero = value => integer(value) === null ? null : integer(value) !== 0
const exactlyOne = value => integer(value) === null ? null : integer(value) === 1
const rank = value => { const n = integer(value); return n > 0 && n <= 20 ? n : null }

// Recognize explicit timestamps and QQ's China-local dates. Unknown formats
// remain unknown; do not invalidate a session or guess its membership type.
function expiryMs(value) {
  if (value === undefined || value === null || value === '') return null
  const raw = String(value).trim()
  if (/^\d{10}$/.test(raw)) return Number(raw) * 1000
  if (/^\d{13}$/.test(raw)) return Number(raw)
  const local = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}):(\d{2}))?$/.exec(raw)
  const parsed = local ? Date.parse(`${local[1]}-${local[2]}-${local[3]}T${local[4] || '23'}:${local[5] || '59'}:${local[6] || '59'}+08:00`)
    : /^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(raw) ? Date.parse(raw) : NaN
  return Number.isFinite(parsed) ? parsed : null
}

export function membershipEntitlements(data, now = Date.now()) {
  const identity = data?.identity
  if (!identity || typeof identity !== 'object' || Array.isArray(identity)) return undefined
  const live = (flag, expires) => {
    const expiry = expiryMs(expires)
    return flag === true && expiry !== null && expiry <= now ? false : flag
  }
  const rights = {
    // `vip` is the current luxury Green Diamond product. The historical name
    // HugeVip means today's higher-tier Super VIP, not luxury Green Diamond.
    greenVip: live(nonzero(identity.vip), identity.overdate),
    luxuryVip: live(nonzero(identity.vip), identity.overdate),
    superVip: live(nonzero(identity.HugeVip), identity.HugeVipEnd),
    annual: nonzero(identity.yearflag),
    eightYuanPack: live(exactlyOne(identity.eight), identity.eightEnd),
    twelveYuanPack: live(exactlyOne(identity.twelve), identity.twelveEnd),
    legacyMember: live(nonzero(data.svip ?? identity.svip), data.send),
    level: rank(identity.level), nextLevel: rank(identity.nextlevel),
    expires: { greenVip: identity.overdate ?? null, luxuryVip: identity.overdate ?? null, superVip: identity.HugeVipEnd ?? null,
      eightYuanPack: identity.eightEnd ?? null, twelveYuanPack: identity.twelveEnd ?? null, legacyMember: data.send ?? null },
  }
  return [rights.luxuryVip, rights.superVip, rights.eightYuanPack, rights.twelveYuanPack, rights.legacyMember].every(value => value === null)
    ? undefined : rights
}

export function membershipFields(data, now = Date.now()) {
  const rights = membershipEntitlements(data, now)
  if (!rights) return undefined
  // Legacy svip and its send expiry do not establish today's Super VIP product.
  const kind = rights.superVip ? 'svip' : rights.luxuryVip ? 'luxury'
    : rights.eightYuanPack || rights.twelveYuanPack || rights.legacyMember ? 'member' : ''
  return kind ? { kind, label: { luxury: '豪华绿钻', svip: '超级会员', member: '音乐会员' }[kind], level: rights.level } : null
}

export function membershipSnapshotFields(data, source, fetchedAt = Date.now()) {
  if (!membershipEntitlements(data, fetchedAt)) return {}
  const identity = {}
  for (const key of identityKeys) {
    const value = data.identity[key]
    if (typeof value === 'boolean' || Number.isSafeInteger(value) || typeof value === 'string' && value.length <= 128) identity[key] = value
  }
  const snapshot = { version: 1, source, fetchedAt, identity }
  for (const key of ['svip', 'send']) {
    const value = data[key]
    if (typeof value === 'boolean' || Number.isSafeInteger(value) || typeof value === 'string' && value.length <= 128) snapshot[key] = value
  }
  return { membershipSnapshot: snapshot, membership: membershipFields(snapshot, fetchedAt),
    membershipFetchedAt: fetchedAt, membershipVersion: MEMBERSHIP_VERSION }
}

export function hasMembershipSnapshot(account) {
  const snapshot = account?.membershipSnapshot
  return snapshot?.version === 1 && ['login', 'fallback'].includes(snapshot.source)
    && membershipEntitlements(snapshot) !== undefined
}
