/**
 * @module provenance
 * @description Evidence records for every datum the app renders — the
 * "where did this number come from and how much do I believe it" layer.
 *
 * The MILLION-X TRUST bet: a globe that claims to show the planet live is
 * only as valuable as the honesty of its pixels. Feeds lie in boring,
 * predictable ways — magnitudes get revised minutes after publication, a
 * provider outage silently serves yesterday's cache, an upstream schema
 * change garbles coordinates (PR #198's malformed-snapshot crash was exactly
 * this class). The fix is not trusting harder; it is making every datum
 * carry its own evidence:
 *
 * - **ProvenanceRecord** — {source, feedId, fetchedAt, observedAt,
 *   confidence, revision, corrections[]}. `fetchedAt` is when WE got it;
 *   `observedAt` is when the SOURCE measured it. The gap between them is the
 *   lie a stale cache tells, and it is measurable.
 * - **Revision chains** — `reviseProvenance()` mints a new record that links
 *   to its parent and accumulates corrections (`{field, from, to, at}`).
 *   USGS revises a M4.2 to M4.5 eighteen minutes later; the revision chain
 *   makes that a first-class fact instead of a silent overwrite.
 * - **Assessment policy** — `assessProvenance()` grades a record against a
 *   policy (max age, minimum confidence, revision tolerance) and returns a
 *   verdict + reasons. Layers can refuse to present data that fails policy,
 *   or degrade its visual treatment, instead of presenting it as gospel.
 * - **WeakMap attachment** — `attachProvenance(entity, record)` hangs
 *   evidence off any object (a Cesium entity, a plain record) without
 *   touching its shape or JSON serialization.
 *
 * Pure data + functions; no timers, no network, no DOM. Node-testable by
 * construction. Confidence is a 0..1 number the *feed adapter* assigns
 * (USGS direct: ~0.9; stale cache serve: ~0.5; community feed: ~0.7) — the
 * scale is deliberately coarse because false precision about trust is just
 * another way to lie.
 */

/** @constant {number} Sanity floor for confidence inputs. */
const CONFIDENCE_MIN = 0;
/** @constant {number} Sanity ceiling for confidence inputs. */
const CONFIDENCE_MAX = 1;
/** @constant {number} Corrections list cap per record (bounded memory). */
const CORRECTIONS_CAP = 16;

/**
 * @typedef {object} ProvenanceCorrection
 * @property {string} field Domain field that changed, e.g. 'mag'.
 * @property {*} from Previous value.
 * @property {*} to New value.
 * @property {number} at When the correction was observed (epoch ms).
 */

/**
 * @typedef {object} ProvenanceRecord
 * @property {string} source Human-readable origin, e.g. 'USGS'.
 * @property {string} feedId Feed identity, e.g. 'earthquakes'.
 * @property {number} fetchedAt Epoch ms — when this app received it.
 * @property {number} observedAt Epoch ms — when the source measured it.
 * @property {number} confidence 0..1 adapter-assigned trust score.
 * @property {number} revision 0 for the original, +1 per correction chain hop.
 * @property {string|null} parentId Record id of the record this revises.
 * @property {string} id Stable record id (feedId#usgsEventId#revision).
 * @property {ReadonlyArray<ProvenanceCorrection>} corrections Accumulated
 *   corrections that produced this revision.
 */

/**
 * @typedef {object} ProvenanceInput
 * @property {string} source
 * @property {string} feedId
 * @property {string} [subjectId] Stable subject id (one record per datum).
 * @property {number} fetchedAt
 * @property {number} observedAt
 * @property {number} [confidence=0.9]
 */

function finiteOr(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Mint a fresh (revision 0) provenance record. Defensive: missing timestamps
 * fall back to `Date.now()` and out-of-range confidence is clamped, because a
 * half-formed record must never be a crash or a lie beyond the one it already
 * is.
 * @param {ProvenanceInput} input
 * @returns {ProvenanceRecord}
 */
export function createProvenanceRecord(input = {}) {
  const feedId = String(input.feedId ?? 'unknown');
  const subjectId = input.subjectId == null ? null : String(input.subjectId);
  const now = Date.now();
  const confidence = Math.min(
    CONFIDENCE_MAX,
    Math.max(CONFIDENCE_MIN, finiteOr(input.confidence, 0.9)),
  );
  return Object.freeze({
    source: String(input.source ?? feedId),
    feedId,
    subjectId,
    fetchedAt: finiteOr(input.fetchedAt, now),
    observedAt: finiteOr(input.observedAt, now),
    confidence,
    revision: 0,
    parentId: null,
    id: `${feedId}#${subjectId ?? 'feed'}#r0`,
    corrections: Object.freeze([]),
  });
}

/**
 * Revise an existing record: mints revision+1, chaining onto the parent with
 * the provided corrections. The parent is never mutated — a revision chain is
 * append-only history, not an edit war.
 * @param {ProvenanceRecord} record
 * @param {{corrections?: Array<{field: string, from: *, to: *}>, at?: number}} [change]
 * @returns {ProvenanceRecord}
 */
export function reviseProvenance(record, change = {}) {
  // Garbage input degrades to a synthetic base — the revision STILL mints
  // (revision 1) and still carries the corrections, because "caller passed
  // garbage" must never discard the evidence they were trying to record.
  const base = (record && typeof record === 'object') ? record : createProvenanceRecord({ feedId: 'unknown' });
  const at = finiteOr(change.at, Date.now());
  const incoming = Array.isArray(change.corrections) ? change.corrections : [];
  const merged = [...base.corrections, ...incoming.map((c) => ({
    field: String(c?.field ?? 'unknown'),
    from: c?.from ?? null,
    to: c?.to ?? null,
    at,
  }))].slice(-CORRECTIONS_CAP);
  const revision = finiteOr(base.revision, 0) + 1;
  return Object.freeze({
    source: base.source,
    feedId: base.feedId,
    subjectId: base.subjectId,
    fetchedAt: at,
    observedAt: base.observedAt,
    // Each revision is a re-observation; confidence carries forward — the
    // correction itself is evidence the source is maintained, not less
    // trustworthy.
    confidence: base.confidence,
    revision,
    parentId: base.id,
    id: `${base.feedId}#${base.subjectId ?? 'feed'}#r${revision}`,
    corrections: Object.freeze(merged),
  });
}

/**
 * @typedef {object} ProvenancePolicy
 * @property {number} [maxAgeMs] How stale `observedAt` may be before the
 *   datum grades 'stale' (default: none).
 * @property {number} [minConfidence] Floor before 'low-confidence' (default 0).
 * @property {number} [maxRevisions] Revision count tolerated before
 *   'volatile' (default: none).
 */

/**
 * @typedef {object} ProvenanceVerdict
 * @property {'trusted'|'stale'|'low-confidence'|'volatile'} verdict
 * @property {string[]} reasons Human-readable findings, in check order.
 */

/**
 * Grade a record against a policy. Verdicts are single-label, priority:
 * stale > low-confidence > volatile > trusted, because lying about freshness
 * is the most dangerous failure mode in a "live" console.
 * @param {ProvenanceRecord} record
 * @param {ProvenancePolicy} [policy]
 * @param {number} [now=Date.now()]
 * @returns {ProvenanceVerdict}
 */
export function assessProvenance(record, policy = {}, now = Date.now()) {
  const reasons = [];
  if (!record || typeof record !== 'object') {
    return { verdict: 'low-confidence', reasons: ['no provenance record'] };
  }
  const currentTime = finiteOr(now, Date.now());

  const maxAgeMs = Number(policy.maxAgeMs);
  const age = currentTime - finiteOr(record.observedAt, 0);
  const isStale = Number.isFinite(maxAgeMs) && age > maxAgeMs;
  if (isStale) reasons.push(`observed ${formatAge(age)} ago exceeds policy ${formatAge(maxAgeMs)}`);

  const minConfidence = Number(policy.minConfidence);
  const lowConfidence = Number.isFinite(minConfidence) && record.confidence < minConfidence;
  if (lowConfidence) reasons.push(`confidence ${record.confidence.toFixed(2)} below floor ${minConfidence.toFixed(2)}`);

  const maxRevisions = Number(policy.maxRevisions);
  const volatile = Number.isFinite(maxRevisions) && record.revision > maxRevisions;
  if (volatile) reasons.push(`revision ${record.revision} exceeds tolerance ${maxRevisions}`);

  if (isStale) return { verdict: 'stale', reasons };
  if (lowConfidence) return { verdict: 'low-confidence', reasons };
  if (volatile) return { verdict: 'volatile', reasons };
  return { verdict: 'trusted', reasons };
}

/** Registry mapping live objects (entities, records) to their evidence. */
const _attachmentRegistry = new WeakMap();

/**
 * Attach evidence to any object without changing its shape (WeakMap: no
 * serialization impact, no leak — the record dies with the object).
 * @param {object} target
 * @param {ProvenanceRecord} record
 * @returns {object} target (chainable).
 */
export function attachProvenance(target, record) {
  if (target && typeof target === 'object' && record && typeof record === 'object') {
    _attachmentRegistry.set(target, record);
  }
  return target;
}

/**
 * Read back attached evidence, if any.
 * @param {object} target
 * @returns {ProvenanceRecord|null}
 */
export function getProvenance(target) {
  if (!target || typeof target !== 'object') return null;
  return _attachmentRegistry.get(target) ?? null;
}

/**
 * Human-readable one-line summary, e.g.
 * "USGS · observed 4m ago · fetched 3s ago · confidence 0.90 · rev 1 (mag 4.2→4.5)".
 * @param {ProvenanceRecord} record
 * @param {{now?: number, corrections?: number}} [options] `corrections` caps
 *   how many corrections are spelled out (default 2).
 * @returns {string}
 */
export function summarizeProvenance(record, options = {}) {
  if (!record || typeof record !== 'object') return 'no provenance';
  const now = finiteOr(options.now, Date.now());
  const correctionCap = Math.max(0, finiteOr(options.corrections, 2));
  const parts = [
    record.source,
    `observed ${formatAge(Math.max(0, now - record.observedAt))} ago`,
    `fetched ${formatAge(Math.max(0, now - record.fetchedAt))} ago`,
    `confidence ${record.confidence.toFixed(2)}`,
  ];
  if (record.revision > 0) {
    parts.push(`rev ${record.revision}`);
    const shown = record.corrections.slice(-correctionCap).map((c) => `${c.field} ${String(c.from)}→${String(c.to)}`);
    if (shown.length) parts.push(`(${shown.join('; ')})`);
  }
  return parts.join(' · ');
}

/**
 * Compact age formatter for summaries and chips.
 * @param {number} ageMs
 * @returns {string}
 */
export function formatAge(ageMs) {
  const ms = Math.max(0, finiteOr(ageMs, 0));
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds < 10 ? seconds.toFixed(1) : Math.round(seconds)}s`;
  const minutes = seconds / 60;
  if (minutes < 60) return `${Math.round(minutes)}m`;
  const hours = minutes / 60;
  if (hours < 24) return `${Math.round(hours)}h`;
  return `${Math.round(hours / 24)}d`;
}
