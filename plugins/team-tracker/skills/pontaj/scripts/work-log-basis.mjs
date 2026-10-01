// The existing description carries provenance until a dedicated schema exists.
// An explicit human reconciliation wins over the legacy estimate tag.
export const HUMAN_HOURS_MARKER = '[pontaj:basis=human_declared]';
export const CONVERSATION_HOURS_MARKER = '[pontaj:basis=conversation_estimate]';

export function workLogBasis(log) {
  const description = String(log.description ?? '');
  const markers = [...description.matchAll(/\[pontaj:basis=([^\]\r\n]*)\]/g)]
    .map(match => match[1]);
  if (description.split('[pontaj:basis').length - 1 !== markers.length) return 'unspecified';
  if (markers.length) {
    const unique = new Set(markers);
    if (unique.size !== 1) return 'unspecified';
    const basis = markers[0];
    return ['human_declared', 'conversation_estimate'].includes(basis) ? basis : 'unspecified';
  }
  if (description.includes('[durată activă estimată din conversație]')) {
    return 'conversation_estimate';
  }
  return 'unspecified';
}

export function summarizeWorkLogs(logs) {
  if (!Array.isArray(logs)) throw Error('Fresh work log rows required');
  const seen = new Map();
  const totals = { human_declared_hours: 0, conversation_estimate_hours: 0, unspecified_hours: 0 };
  for (const log of logs) {
    if (!Number.isSafeInteger(log.id)) throw Error('Verified work log ID required');
    const hours = Number(log.hours);
    if (!Number.isFinite(hours) || hours <= 0 || hours > 24) throw Error('Invalid work log hours');
    const basis = workLogBasis(log);
    const identity = JSON.stringify([hours, basis, log.member, log.work_date, log.project_id]);
    if (seen.has(log.id)) {
      if (seen.get(log.id) !== identity) throw Error('Conflicting duplicate work log');
      continue;
    }
    seen.set(log.id, identity);
    totals[`${basis}_hours`] += hours;
  }
  return { ...totals, requires_reconciliation: totals.conversation_estimate_hours > 0 || totals.unspecified_hours > 0 };
}
