export function previousHeldPresentation(presentations, projectId, audienceId, before = new Date().toISOString()) {
  const cutoff = Date.parse(before);
  if (!Number.isFinite(cutoff)) throw Error('invalid_cutoff');
  return presentations.filter(p => p.project_id === projectId && p.audience_id === audienceId && p.status === 'held' && p.closed_snapshot && Number.isFinite(Date.parse(p.held_at)) && Date.parse(p.held_at) < cutoff)
    .sort((a, b) => Date.parse(b.held_at)-Date.parse(a.held_at))[0] || null;
}

export function changeState(evidence, appVersion) {
  if (evidence.blocked) return 'blocked';
  if (!evidence.implemented) return 'in_progress';
  if (!appVersion || !evidence.published || evidence.deployedCommit !== appVersion) return 'in_progress';
  if (!evidence.browserVerified || evidence.verifiedCommit !== appVersion || !evidence.testPassed) return 'unverified';
  return 'verified';
}

export function carryoverChanges(previous) {
  if (!previous?.closed_snapshot) return [];
  const { presentation, run } = previous.closed_snapshot;
  const document = presentation.document;
  return document.changes.filter(change => {
    if (!change.selected) return false;
    const steps = document.steps.filter(step => step.change_id === change.id);
    return !steps.length || steps.some(step => !run?.results?.some(result => result.step_id === step.id && result.status === 'passed'));
  });
}

// Pure preview of server regeneration: human edits stay, machine evidence is refreshed.
export function appendNewCandidates(current, candidates) {
  const key = value => value.source_id === null ? `manual:${value.id}` : `${value.source_type}:${value.source_id}`;
  const known = new Set(current.map(key));
  const refreshed = current.map(change => {
    if (change.source_type === 'manual' || change.source_id === null) return change;
    const candidate = candidates.find(value => key(value) === key(change));
    if (!candidate) return change;
    return { ...change, ...(candidate.state === undefined ? {} : { state: candidate.state }), ...(candidate.evidence === undefined ? {} : { evidence: candidate.evidence }) };
  });
  return [...refreshed, ...candidates.filter(candidate => { const value = key(candidate); if (known.has(value)) return false; known.add(value); return true; })];
}
