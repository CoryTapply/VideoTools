// Spike B -- sample index at scale. Scaffolded, not yet implemented.
// See prompts/m0.5-spike-prompts.md for the full spec. Depends on spike A's
// index builder (src/spikes/A-remux/mp4-index.ts) once that lands.

document.getElementById('app')!.innerHTML = `
  <p><a href="/">&larr; all spikes</a></p>
  <h1>spike B: sample index at scale</h1>
  <p>Not yet implemented -- reuses spike A's index builder. See
  <code>prompts/m0.5-spike-prompts.md</code> for the spec: correctness
  cross-check against mediabunny, scale test on the 27GB fixture, query
  latency, worker transfer, VFR reporting, OPFS persistence.</p>
`;
