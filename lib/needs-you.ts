import type { Bead } from "./schema";
import { BLOCKING_DEP_TYPES } from "./schema";
import {
  blockingDeps,
  isBlocked,
  isHumanGate,
  needsHuman,
  parentOf,
} from "./beads-view";

/**
 * Pure view-model for the "Needs You" inbox: which items exist, which are
 * blocked, how they sort, and how they group under their parent. Kept apart
 * from `needsHuman`/`readyHumanGate`, which also drive notifications and the
 * sidebar badge and must keep meaning "actionable right now".
 */
export const NEEDS_YOU_SORTS = ["priority", "unblocks", "newest", "oldest"] as const;
export type NeedsYouSort = (typeof NEEDS_YOU_SORTS)[number];

export const NEEDS_YOU_SORT_LABELS: Record<NeedsYouSort, string> = {
  priority: "Priority",
  unblocks: "Unblocks most",
  newest: "Newest",
  oldest: "Oldest",
};

export type NeedsYouShow = "all" | "unblocked";

export interface NeedsYouPrefs {
  sort: NeedsYouSort;
  show: NeedsYouShow;
}

const SORT_PARAM = "nysort";
const SHOW_PARAM = "nyshow";

/** Parse the inbox controls; unknown values fall back to the defaults. */
export function needsYouPrefsFromParams(params: Pick<URLSearchParams, "get">): NeedsYouPrefs {
  const sort = params.get(SORT_PARAM);
  return {
    sort: NEEDS_YOU_SORTS.find((s) => s === sort) ?? "priority",
    show: params.get(SHOW_PARAM) === "unblocked" ? "unblocked" : "all",
  };
}

/** Write the inbox controls, leaving defaults out so plain links stay plain. */
export function writeNeedsYouPrefs(params: URLSearchParams, prefs: NeedsYouPrefs): void {
  if (prefs.sort === "priority") params.delete(SORT_PARAM);
  else params.set(SORT_PARAM, prefs.sort);
  if (prefs.show === "all") params.delete(SHOW_PARAM);
  else params.set(SHOW_PARAM, prefs.show);
}

export interface NeedsYouItem {
  bead: Bead;
  kind: "gate" | "question";
  blocked: boolean;
  /** Named blockers. Empty on a bead marked `blocked` by hand. */
  blockers: string[];
  /** Open beads transitively waiting on this one. */
  unblocks: number;
}

export interface NeedsYouGroup {
  /** Null for the final "No epic" group. */
  parent: Bead | null;
  items: NeedsYouItem[];
}

/** Bead id → the beads that depend on it through a blocking edge. */
function dependentsMap(beads: Bead[]): Map<string, string[]> {
  const m = new Map<string, string[]>();
  for (const b of beads) {
    for (const d of b.dependencies ?? []) {
      if (!BLOCKING_DEP_TYPES.includes(d.type as never)) continue;
      const list = m.get(d.depends_on_id);
      if (list) list.push(b.id);
      else m.set(d.depends_on_id, [b.id]);
    }
  }
  return m;
}

function openDependents(
  id: string,
  dependents: Map<string, string[]>,
  index: Map<string, Bead>,
): number {
  // `seen` also keeps a dependency cycle from looping forever.
  const seen = new Set<string>([id]);
  const stack = [...(dependents.get(id) ?? [])];
  let count = 0;
  while (stack.length) {
    const next = stack.pop()!;
    if (seen.has(next)) continue;
    seen.add(next);
    if (index.has(next) && index.get(next)?.status !== "closed") count += 1;
    stack.push(...(dependents.get(next) ?? []));
  }
  return count;
}

/**
 * Every item waiting on a person, blocked or not. Unlike `readyHumanGate`, this
 * includes open gates that are still blocked, so "All" really means all.
 */
export function needsYouItems(beads: Bead[], index: Map<string, Bead>): NeedsYouItem[] {
  const dependents = dependentsMap(beads);
  const items: NeedsYouItem[] = [];
  for (const bead of beads) {
    const gate = isHumanGate(bead) && bead.status !== "closed";
    if (!gate && !needsHuman(bead)) continue;
    items.push({
      bead,
      kind: gate ? "gate" : "question",
      blocked: isBlocked(bead, index),
      blockers: blockingDeps(bead, index),
      unblocks: openDependents(bead.id, dependents, index),
    });
  }
  return items;
}

function timeOf(b: Bead): number {
  const t = Date.parse(b.updated_at ?? b.created_at ?? "");
  return Number.isNaN(t) ? 0 : t;
}

function compareItems(a: NeedsYouItem, b: NeedsYouItem, sort: NeedsYouSort): number {
  const primary =
    sort === "priority" ? a.bead.priority - b.bead.priority
    : sort === "unblocks" ? b.unblocks - a.unblocks
    : sort === "newest" ? timeOf(b.bead) - timeOf(a.bead)
    : timeOf(a.bead) - timeOf(b.bead);
  return primary || a.bead.id.localeCompare(b.bead.id);
}

/**
 * Group items under their nearest parent. Items sort within a group, and a
 * group ranks by its best item. "No epic" always comes last.
 */
export function groupNeedsYou(
  items: NeedsYouItem[],
  index: Map<string, Bead>,
  sort: NeedsYouSort,
): NeedsYouGroup[] {
  const groups = new Map<string, NeedsYouGroup>();
  const orphans: NeedsYouItem[] = [];
  for (const item of items) {
    const parent = parentOf(item.bead, index);
    if (!parent) {
      orphans.push(item);
      continue;
    }
    const group = groups.get(parent.id);
    if (group) group.items.push(item);
    else groups.set(parent.id, { parent, items: [item] });
  }
  const byRank = (a: NeedsYouItem, b: NeedsYouItem) => compareItems(a, b, sort);
  const sorted = [...groups.values()];
  for (const group of sorted) group.items.sort(byRank);
  sorted.sort((a, b) => byRank(a.items[0], b.items[0]));
  return orphans.length
    ? [...sorted, { parent: null, items: orphans.sort(byRank) }]
    : sorted;
}
