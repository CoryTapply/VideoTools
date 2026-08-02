// Spike C -- WebCodecs scrub + thumbnails. Scaffolded, not yet implemented.
// See prompts/m0.5-spike-prompts.md for the full spec. Depends on the index
// from spikes A/B once those land.

document.getElementById('app')!.innerHTML = `
  <p><a href="/">&larr; all spikes</a></p>
  <h1>spike C: WebCodecs scrub + thumbnails</h1>
  <p>Not yet implemented -- uses the index from spikes A/B. See
  <code>prompts/m0.5-spike-prompts.md</code> for the spec: keyframe
  throughput, arbitrary-frame latency vs the &lt;video&gt; baseline,
  cache-backed scrub simulation, leak test, thumbnail atlas.</p>
`;
