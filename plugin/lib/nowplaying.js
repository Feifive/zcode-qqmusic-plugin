export function pickSession(sessions, { apps = ['qqmusic'], anyApp = false } = {}) {
  if (!Array.isArray(sessions)) return null
  const filtered = sessions.filter(s => s && (anyApp || apps.some(app => String(s.app).toLowerCase().includes(app))))
  return filtered.find(s => s.status === 'playing') ?? filtered[0] ?? null
}

export function splitTitle(title, artist) {
  title = String(title ?? '').trim()
  artist = String(artist ?? '').trim()
  const i = title.lastIndexOf(' - ')
  return !artist && i > 0 ? { title: title.slice(0, i).trim(), artist: title.slice(i + 3).trim() } : { title, artist }
}

// QQ Music can leave PlaybackRate=1 and its last ElapsedTime after pausing.
// The native adapter reads the real isPlaying flag; retain the last playhead
// when that player supplies no new timeline sample for the paused state.
export function normalizeMacSample(sample, previous) {
  if (!Array.isArray(sample?.sessions)) return sample
  return { ...sample, sessions: sample.sessions.map(session => {
    if (!session.timelineTimestamp) return session
    const before = previous?.sessions?.find(s => s.app === session.app && s.title === session.title && s.artist === session.artist && s.timelineTimestamp === session.timelineTimestamp)
    if (!before) return session
    const reported = session.reportedPosition ?? session.position
    if (reported !== 0 && reported !== (before.reportedPosition ?? before.position)) return session
    if (session.status === 'paused' && session.position > before.position) return session
    const age = Math.max(0, Math.min(5000, sample.at - previous.at))
    let position = session.position
    let positionCorrection = before.positionCorrection || 0
    if (session.status === 'paused') {
      position = before.position + (before.status === 'playing' ? age : 0)
    } else if (before.status === 'paused') {
      position = before.position + age
      positionCorrection = session.position - position
    } else if (positionCorrection) {
      position = session.position - positionCorrection
    }
    return { ...session, position: Math.min(session.duration || Infinity, Math.max(0, position)), positionCorrection }
  }) }
}
