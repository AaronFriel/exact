/** Locate each new failure independently; an obstructed probe never counts as a pass. */
export async function bisectFailures(commits, failures, probe) {
  if (commits.length < 2) return Object.fromEntries(failures.map(f => [f, { unresolved: 'no earlier commit to compare' }]));
  const cache = new Map();
  const at = async sha => {
    if (!cache.has(sha)) cache.set(sha, await probe(sha, failures));
    return cache.get(sha);
  };
  const out = {};
  for (const failure of failures) {
    let good = 0, bad = commits.length - 1;
    const first = (await at(commits[good]))[failure];
    if (first === 'fail') { out[failure] = { preexisting: commits[good] }; continue; }
    if (first !== 'pass') { out[failure] = { unresolved: 'baseline probe did not finish', good: null, bad: commits[bad] }; continue; }
    if ((await at(commits[bad]))[failure] !== 'fail') {
      out[failure] = { unresolved: 'tip failure did not reproduce', good: commits[good], bad: commits[bad] };
      continue;
    }
    let obstruction;
    while (bad - good > 1) {
      const mid = Math.floor((good + bad) / 2), status = (await at(commits[mid]))[failure];
      if (status === 'fail') bad = mid;
      else if (status === 'pass') good = mid;
      else { obstruction = commits[mid]; break; }
    }
    out[failure] = obstruction
      ? { unresolved: `probe did not finish at ${obstruction}`, good: commits[good], bad: commits[bad] }
      : { commit: commits[bad], parent: commits[good] };
  }
  return out;
}

/** The same failure names at a probe: other compile failures, timeouts and omitted steps obstruct attribution. */
export function probeOutcomes(result, wanted) {
  return Object.fromEntries(wanted.map(f => {
    const check = result.checks[f.split(': ', 1)[0]];
    return [f, result.failures.includes(f) ? 'fail' : check && !check.skipped && check.complete && check.status === 0 ? 'pass' : 'unknown'];
  }));
}

/** Confirm the actual parent after pruning unrelated commits; a missed input cannot assign blame. */
export async function bisectAffected(base, tip, failures, candidates, probe, parentOf) {
  const cache = new Map(), out = {};
  const at = async sha => {
    if (!cache.has(sha)) cache.set(sha, await probe(sha, failures));
    return cache.get(sha);
  };
  for (const failure of failures) {
    const relevant = candidates.get(failure) ?? [];
    if (!relevant.length) {
      out[failure] = { unresolved: 'no commit in the range changes a known input of this failure', good: base, bad: tip };
      continue;
    }
    const commits = [...new Set([base, ...relevant, tip])];
    let found = (await bisectFailures(commits, [failure], at))[failure];
    if (found.commit) {
      const parent = await parentOf(found.commit);
      if (!relevant.includes(found.commit) || (await at(parent))[failure] !== 'pass') {
        found = { unresolved: 'the actual parent did not confirm the affected-commit boundary', good: base, bad: found.commit };
      } else found.parent = parent;
    }
    out[failure] = found;
  }
  return out;
}
