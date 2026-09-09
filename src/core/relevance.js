/**
 * @module relevance
 * @description Scoring + budget-constrained selection for "which of N things
 * deserves the user's attention right now".
 *
 * The MILLION-X ATTENTION bet: the optimization wave taught the hard lesson —
 * constrained budgets (label caps, cohort limits, MSAA tiers) are the price
 * of a smooth globe, and the only honest question left is *what gets cut*.
 * Before this module, budget math was magnitude-first and time-blind: a
 * M6.5 that happened 23 hours ago outranked a M4.9 that happened 90 seconds
 * ago, every time, because priority was `round(mag * 1000)`. On a live
 * intelligence console that is precisely backwards — "live" means recent
 * events matter more, and shrinking budgets must shed the LEAST relevant
 * labels, not arbitrary ones. Relevance = severity × recency decay:
 *
 * - **Recency decay** — exponential with an injectable half-life (default
 *   6 h, tuned for a 24 h earthquake feed: a 12 h-old event carries 1/4 the
 *   weight of a fresh one, a 24 h-old event 1/16).
 * - **Severity curve** — normalized power curve over a configurable range;
 *   earthquakes pass magnitude on their natural (exponential) scale, other
 *   layers can pass 0..1 directly.
 * - **Interaction boost** — anything the user has touched (clicked, pinned)
 *   gets a multiplier so the console remembers what THIS user cares about
 *   even as the world floods in.
 * - **Selection with fallback** — `selectWithinRelevanceBudget()` returns
 *   `null` when NO item carries relevance signals (no observedAt, no
 *   severity): the caller keeps its legacy ordering verbatim. That is the
 *   compatibility contract — relevance upgrades adopters; it never
 *   ambushes them.
 *
 * Tie-breaking is stable and deterministic (score desc, then id asc) so a
 * cohort cannot reshuffle frame-to-frame purely on sort instability.
 * Pure functions, injectable clock, Node-testable.
 */

/** @constant {number} Default recency half-life: 6 hours. */
export const DEFAULT_HALF_LIFE_MS = 6 * 60 * 60 * 1000;
/** @constant {number} Default severity power-curve exponent. */
const DEFAULT_SEVERITY_EXPONENT = 1.5;
/** @constant {number} Floor added to normalized severity so small events stay selectable. */
const SEVERITY_FLOOR = 0.05;
/** @constant {number} Default interaction multiplier (user touched it → 2×). */
const DEFAULT_INTERACTION_BOOST = 2;
/** @constant {number} Recency decay floor (don't let long-horizon events hit exactly 0). */
const DECAY_FLOOR = 0.001;

/**
 * @typedef {object} RelevanceScorerOptions
 * @property {() => number} [now] Clock (default Date.now).
 * @property {number} [halfLifeMs] Recency half-life.
 * @property {number} [severityExponent] Power-curve exponent for severity.
 * @property {[number, number]} [severityRange] [min, max] domain of the
 *   severity getter; normalized outside it. Default [0, 1].
 * @property {number} [interactionBoost] Multiplier for interacted items.
 * @property {(item: *) => number|null} [observedAtOf] Accessor: when the
 *   item happened (epoch ms). Default `item.observedAt`.
 * @property {(item: *) => number|null} [severityOf] Accessor: domain
 *   severity (e.g. magnitude). Default `item.severity`.
 * @property {(item: *) => number|null} [interactedAtOf] Accessor: when the
 *   user last touched the item. Default `item.interactedAt`.
 */

/**
 * Exponential recency factor: 1 at age 0, 0.5 at one half-life, floored so
 * extreme ages never zero out (a relevant event from 23 h ago still outranks
 * an irrelevant one from 1 h ago).
 * @param {number} ageMs Non-negative age.
 * @param {number} halfLifeMs
 * @returns {number}
 */
export function recencyDecay(ageMs, halfLifeMs = DEFAULT_HALF_LIFE_MS) {
  const age = Number.isFinite(ageMs) ? Math.max(0, ageMs) : 0;
  const half = Number.isFinite(halfLifeMs) && halfLifeMs > 0 ? halfLifeMs : DEFAULT_HALF_LIFE_MS;
  return Math.max(DECAY_FLOOR, Math.pow(0.5, age / half));
}

/**
 * Normalize a domain severity onto [0, 1] with a power curve: linear ranges
 * under-represent how much more a M6 matters than a M3.
 * @param {number} severity Raw severity in the domain's units.
 * @param {RelevanceScorerOptions} [options]
 * @returns {number}
 */
export function normalizeSeverity(severity, options = {}) {
  const range = Array.isArray(options.severityRange) ? options.severityRange : [0, 1];
  const exponent = Number.isFinite(options.severityExponent)
    ? Math.max(0.1, options.severityExponent)
    : DEFAULT_SEVERITY_EXPONENT;
  const min = Number.isFinite(range[0]) ? range[0] : 0;
  const max = Number.isFinite(range[1]) ? range[1] : 1;
  const span = max - min;
  if (!(span > 0) || !Number.isFinite(severity)) return 0;
  const clamped = Math.min(1, Math.max(0, (severity - min) / span));
  return SEVERITY_FLOOR + (1 - SEVERITY_FLOOR) * Math.pow(clamped, exponent);
}

/**
 * Build a scoring function from the accessors + curve options. The returned
 * scorer answers `null` for items with no relevance signals at all —
 * "unknown" is not "irrelevant".
 * @param {RelevanceScorerOptions} [options]
 * @returns {(item: *) => number|null}
 */
export function createRelevanceScorer(options = {}) {
  const now = typeof options.now === 'function' ? options.now : () => Date.now();
  const observedAtOf = typeof options.observedAtOf === 'function' ? options.observedAtOf : (item) => item?.observedAt ?? null;
  const severityOf = typeof options.severityOf === 'function' ? options.severityOf : (item) => item?.severity ?? null;
  const interactedAtOf = typeof options.interactedAtOf === 'function' ? options.interactedAtOf : (item) => item?.interactedAt ?? null;
  const halfLifeMs = options.halfLifeMs ?? DEFAULT_HALF_LIFE_MS;
  const interactionBoost = Number.isFinite(options.interactionBoost)
    ? Math.max(1, options.interactionBoost)
    : DEFAULT_INTERACTION_BOOST;

  return function scoreRelevance(item) {
    if (!item) return null;
    // Signal detection must happen BEFORE Number() coercion — Number(null)
    // is 0, which is finite, and would misread "no signal" as "epoch zero".
    const rawObservedAt = observedAtOf(item);
    const hasObservedAt = rawObservedAt != null && Number.isFinite(Number(rawObservedAt));
    const observedAt = hasObservedAt ? Number(rawObservedAt) : null;
    const rawSeverity = severityOf(item);
    const hasSeverity = rawSeverity != null && Number.isFinite(Number(rawSeverity));
    const severity = hasSeverity ? Number(rawSeverity) : null;
    if (!hasObservedAt && !hasSeverity) return null; // no signals → caller's fallback
    const currentTime = now();

    let score;
    if (hasSeverity) {
      const severityWeight = normalizeSeverity(severity, options);
      score = hasObservedAt
        ? severityWeight * recencyDecay(currentTime - observedAt, halfLifeMs)
        : severityWeight;
    } else {
      // Time-only relevance: recent-but-unmeasured still beats unknown age.
      score = 0.5 * recencyDecay(currentTime - observedAt, halfLifeMs);
    }

    const rawInteractedAt = interactedAtOf(item);
    if (rawInteractedAt != null && Number.isFinite(Number(rawInteractedAt))) {
      // Interaction boost itself decays — yesterday's click matters less.
      const interactedAt = Number(rawInteractedAt);
      score *= 1 + (interactionBoost - 1) * recencyDecay(currentTime - interactedAt, halfLifeMs);
    }
    return score;
  };
}

/**
 * Budget-constrained top-K selection. Contract (compatibility-critical):
 * - `budget <= 0` → `[]` (definitely nothing).
 * - NO item scores (all unknown) → `null` — caller falls back to its legacy
 *   ordering. Relevance must upgrade adopters, never ambush them.
 * - Mixed: scored items rank first (score desc, id asc tie-break), unscored
 *   items follow in input order, top `budget` overall — known-relevance
 *   beats unknown-relevance, and the unknown segment degrades gracefully.
 * @param {Array<*>} items
 * @param {number} budget
 * @param {RelevanceScorerOptions} [options]
 * @returns {Array<*>|null}
 */
export function selectWithinRelevanceBudget(items, budget, options = {}) {
  if (!Array.isArray(items)) return null;
  const cap = Math.floor(Number(budget));
  if (!Number.isFinite(cap) || cap <= 0) return [];
  const scorer = createRelevanceScorer(options);

  const scored = [];
  const unscored = [];
  for (const item of items) {
    const score = scorer(item);
    if (score == null) unscored.push(item);
    else scored.push({ item, score });
  }
  if (!scored.length) return null; // zero relevance signal anywhere

  scored.sort((a, b) => (
    b.score - a.score || String(a.item?.id ?? '').localeCompare(String(b.item?.id ?? ''))
  ));
  const selection = scored.map((entry) => entry.item);
  if (selection.length < cap) {
    selection.push(...unscored.slice(0, cap - selection.length));
  }
  return selection.slice(0, cap);
}
