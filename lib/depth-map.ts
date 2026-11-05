import { FLOW_DEP_TYPES, type Bead } from "./schema";
import { category, isBlocked, makeIndex, needsHuman, readyHumanGate } from "./beads-view";
import { buildEpicGraphScope, dependencyComponents } from "./graph-epic";

/**
 * Pure model and layout for the Roadmap view: beads in columns by dependency
 * depth. Every traversal is iterative, so deep chains cannot overflow the stack,
 * and all output is independent of input order, so a live refresh with the same
 * data places every node exactly where it was.
 */

export type MapState = "done" | "doing" | "ready" | "blocked" | "frozen";

export interface DepthMapOptions {
  /** Remove closed beads, so depth counts remaining steps only. */
  hideCompleted?: boolean;
  /** Keep beads with no visible depth edge in the columns. */
  showUnlinked?: boolean;
  /** Limit the map to an epic, its descendants and one hop of outside context. */
  epicId?: string;
}

export interface DepthMapNode {
  bead: Bead;
  state: MapState;
  depth: number;
  /** Position in the next-up order. Only actionable, ranked beads have one. */
  rank?: number;
  /** Open beads transitively waiting on this one. */
  unblocks: number;
  critical: boolean;
  inCycle: boolean;
  needsYou: boolean;
  outsideEpic: boolean;
  /** Unfinished blockers with no node on the map, including ids not in the project. */
  hiddenBlockers: string[];
  /** Top-level ancestor, used to group rows and label the node. */
  epic?: { id: string; title: string };
}

export interface DepthMapEdge {
  /** `${dependent}->${prerequisite}:${type}`, as in the Graph view. */
  id: string;
  /** Prerequisite. */
  from: string;
  /** Dependent. */
  to: string;
  /** The prerequisite is closed. */
  met: boolean;
  critical: boolean;
}

export interface DepthMap {
  /** Ordered top to bottom. */
  columns: DepthMapNode[][];
  edges: DepthMapEdge[];
  /** Open beads on the longest remaining chain. */
  longestChain: number;
  /** Work items in scope. Epics are excluded, and so are archived beads. */
  counts: Record<MapState, number>;
  cycles: number;
  /** Beads with no visible depth edge, whether or not they are collapsed. */
  unlinkedCount: number;
  /** Beads collapsed out of the columns for having no visible depth edge. */
  hiddenUnlinked: string[];
}

const FLOW = new Set<string>(FLOW_DEP_TYPES);
const SWEEPS = 4;

const isArchived = (bead: Bead) => (bead.labels ?? []).includes("archived");
const isEpic = (bead: Bead) => bead.issue_type === "epic";
const flowDeps = (bead: Bead) => (bead.dependencies ?? []).filter((dep) => FLOW.has(dep.type));
const byId = (a: string, b: string) => a.localeCompare(b);

function pushTo(map: Map<string, string[]>, key: string, value: string) {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

/** Always evaluated against the full index, so hidden beads still count. */
export function mapState(bead: Bead, index: Map<string, Bead>): MapState {
  const group = category(bead.status);
  if (group === "done") return "done";
  if (group === "wip") return "doing";
  if (group === "frozen") return "frozen";
  return isBlocked(bead, index) ? "blocked" : "ready";
}

/** Resolves each bead's top-level ancestor once, tolerating hierarchy cycles. */
function topAncestors(index: Map<string, Bead>) {
  const known = new Map<string, Bead>();
  const parent = (bead: Bead) => {
    const edge = (bead.dependencies ?? []).find((dep) => dep.type === "parent-child");
    return edge ? (index.get(edge.depends_on_id) ?? null) : null;
  };
  return (bead: Bead): Bead | null => {
    const path = new Set<string>();
    let current = bead;
    let top = known.get(current.id);
    while (!top) {
      path.add(current.id);
      const next = parent(current);
      if (!next || path.has(next.id)) top = current;
      else {
        current = next;
        top = known.get(current.id);
      }
    }
    for (const id of path) known.set(id, top);
    return top.id === bead.id && !isEpic(bead) ? null : top;
  };
}

/**
 * Which beads get a node, before unlinked ones collapse. Deferred and pinned
 * beads stay hidden unless they hold up unfinished work, because a frozen
 * blocker silently stalls everything behind it. Epics only appear when a depth
 * edge makes them part of the order of work; otherwise they would sit under
 * `NO BLOCKERS` and look actionable.
 */
function visibleBeads(scope: Bead[], hideCompleted: boolean): Bead[] {
  const candidates = new Map<string, Bead>();
  for (const bead of scope) {
    if (isArchived(bead) || candidates.has(bead.id)) continue;
    if (hideCompleted && bead.status === "closed") continue;
    candidates.set(bead.id, bead);
  }

  const frozen = (bead: Bead) => category(bead.status) === "frozen";
  const shown = new Map([...candidates].filter(([, bead]) => !frozen(bead)));
  const pending = [...shown.values()].filter((bead) => bead.status !== "closed");
  for (let cursor = 0; cursor < pending.length; cursor += 1) {
    for (const dep of flowDeps(pending[cursor])) {
      const target = candidates.get(dep.depends_on_id);
      if (!target || shown.has(target.id)) continue;
      shown.set(target.id, target);
      pending.push(target);
    }
  }

  const linked = new Set<string>();
  for (const bead of shown.values()) {
    for (const dep of flowDeps(bead)) {
      if (!shown.has(dep.depends_on_id) || dep.depends_on_id === bead.id) continue;
      linked.add(bead.id);
      linked.add(dep.depends_on_id);
    }
  }
  return [...shown.values()].filter((bead) => !isEpic(bead) || linked.has(bead.id));
}

/**
 * Order each column. Rows start grouped by top-level epic, then barycenter
 * sweeps pull neighbours level with each other to reduce crossings. Priority
 * and id break ties, so the result is deterministic.
 */
function orderColumns(columns: DepthMapNode[][], edges: DepthMapEdge[]): DepthMapNode[][] {
  const groupKey = (node: DepthMapNode) => node.epic?.id ?? "￿";
  const ordered = columns.map((column) =>
    [...column].sort(
      (a, b) =>
        groupKey(a).localeCompare(groupKey(b)) ||
        a.bead.priority - b.bead.priority ||
        byId(a.bead.id, b.bead.id),
    ),
  );

  const before = new Map<string, string[]>();
  const after = new Map<string, string[]>();
  for (const edge of edges) {
    pushTo(before, edge.to, edge.from);
    pushTo(after, edge.from, edge.to);
  }

  const row = new Map<string, number>();
  const remember = (column: DepthMapNode[]) => column.forEach((node, i) => row.set(node.bead.id, i));
  ordered.forEach(remember);

  const sweep = (column: DepthMapNode[], neighbours: Map<string, string[]>) => {
    const rank = new Map(
      column.map((node, i) => {
        const rows = (neighbours.get(node.bead.id) ?? []).map((id) => row.get(id) ?? i);
        // A bead with no neighbour on this side holds its row.
        return [node.bead.id, rows.length ? rows.reduce((sum, r) => sum + r, 0) / rows.length : i];
      }),
    );
    column.sort(
      (a, b) =>
        rank.get(a.bead.id)! - rank.get(b.bead.id)! ||
        a.bead.priority - b.bead.priority ||
        byId(a.bead.id, b.bead.id),
    );
    remember(column);
  };

  for (let pass = 0; pass < SWEEPS; pass += 1) {
    if (pass % 2 === 0) for (let c = 1; c < ordered.length; c += 1) sweep(ordered[c], before);
    else for (let c = ordered.length - 2; c >= 0; c -= 1) sweep(ordered[c], after);
  }
  return ordered;
}

export function buildDepthMap(beads: Bead[], options: DepthMapOptions = {}): DepthMap {
  const { hideCompleted = false, showUnlinked = false, epicId } = options;
  const index = makeIndex(beads);
  const scope = epicId ? buildEpicGraphScope(beads, epicId) : null;
  const scoped = scope ? scope.beads : beads;
  const visible = visibleBeads(scoped, hideCompleted);
  const present = new Map(visible.map((bead) => [bead.id, bead]));
  const graph = dependencyComponents(visible, FLOW_DEP_TYPES);

  const edges: DepthMapEdge[] = [];
  const edgeIds = new Set<string>();
  const dependents = new Map<string, string[]>();
  const linked = new Set<string>();
  for (const bead of visible) {
    for (const dep of flowDeps(bead)) {
      const from = dep.depends_on_id;
      if (!present.has(from) || from === bead.id) continue;
      const id = `${bead.id}->${from}:${dep.type}`;
      if (edgeIds.has(id)) continue;
      edgeIds.add(id);
      edges.push({ id, from, to: bead.id, met: present.get(from)!.status === "closed", critical: false });
      linked.add(from);
      linked.add(bead.id);
      pushTo(dependents, from, bead.id);
    }
  }
  edges.sort((a, b) => byId(a.id, b.id));

  // Longest remaining chain, on the condensed graph so a cycle counts once with
  // the weight of its open members. Closed beads weigh nothing.
  const { components, componentEdges, componentOf, topologicalOrder } = graph;
  const weight = components.map(
    (members) => members.filter((id) => present.get(id)!.status !== "closed").length,
  );
  const up = [...weight];
  const down = [...weight];
  for (const component of topologicalOrder) {
    for (const target of componentEdges.get(component)!) {
      up[target] = Math.max(up[target], up[component] + weight[target]);
    }
  }
  for (const component of [...topologicalOrder].reverse()) {
    for (const target of componentEdges.get(component)!) {
      down[component] = Math.max(down[component], down[target] + weight[component]);
    }
  }
  const through = (component: number) => up[component] + down[component] - weight[component];
  const longestChain = components.reduce(
    (longest, _, component) => (weight[component] ? Math.max(longest, through(component)) : longest),
    0,
  );
  // One step is not a chain: with independent beads everything would be "critical".
  const onCriticalPath = (id: string) => {
    const component = componentOf.get(id)!;
    return (
      longestChain >= 2 &&
      present.get(id)!.status !== "closed" &&
      through(component) === longestChain
    );
  };
  for (const edge of edges) {
    const from = componentOf.get(edge.from)!;
    const to = componentOf.get(edge.to)!;
    // Both ends being critical is not enough: tied chains would appear to join.
    edge.critical =
      from !== to &&
      onCriticalPath(edge.from) &&
      onCriticalPath(edge.to) &&
      up[from] + down[to] === longestChain;
  }

  const unblocksFrom = (id: string) => {
    const seen = new Set<string>();
    const pending = [id];
    while (pending.length) {
      for (const next of dependents.get(pending.pop()!) ?? []) {
        if (seen.has(next) || present.get(next)!.status === "closed") continue;
        seen.add(next);
        pending.push(next);
      }
    }
    seen.delete(id);
    return seen.size;
  };

  const ancestorOf = topAncestors(index);
  const nodes = new Map<string, DepthMapNode>();
  for (const bead of visible) {
    const state = mapState(bead, index);
    const component = componentOf.get(bead.id)!;
    const blockers = new Set<string>();
    if (state !== "done") {
      for (const dep of flowDeps(bead)) {
        const target = dep.depends_on_id;
        if (present.has(target) || index.get(target)?.status === "closed") continue;
        blockers.add(target);
      }
    }
    const ancestor = ancestorOf(bead);
    nodes.set(bead.id, {
      bead,
      state,
      depth: graph.componentLayers[component],
      unblocks: state === "done" ? 0 : unblocksFrom(bead.id),
      critical: onCriticalPath(bead.id),
      inCycle: components[component].length > 1,
      needsYou: needsHuman(bead) || readyHumanGate(bead, index),
      outsideEpic: !!scope?.outsideIds.has(bead.id),
      hiddenBlockers: [...blockers].sort(byId),
      epic: ancestor ? { id: ancestor.id, title: ancestor.title } : undefined,
    });
  }

  const unlinked = visible
    .filter((bead) => !linked.has(bead.id))
    .map((bead) => bead.id)
    .sort(byId);
  const hiddenUnlinked = showUnlinked ? [] : unlinked;
  const collapsed = new Set(hiddenUnlinked);
  const shown = [...nodes.values()].filter((node) => !collapsed.has(node.bead.id));

  // Ranked only among nodes on the map, so `NEXT n` never points at a hidden bead.
  shown
    .filter((node) => node.state === "ready" && !isEpic(node.bead) && !node.needsYou)
    .sort(
      (a, b) =>
        Number(b.critical) - Number(a.critical) ||
        a.bead.priority - b.bead.priority ||
        b.unblocks - a.unblocks ||
        byId(a.bead.id, b.bead.id),
    )
    .forEach((node, i) => {
      node.rank = i + 1;
    });

  const columnCount = shown.reduce((count, node) => Math.max(count, node.depth + 1), 0);
  const columns: DepthMapNode[][] = Array.from({ length: columnCount }, () => []);
  for (const node of shown) columns[node.depth].push(node);

  const counts: Record<MapState, number> = { done: 0, doing: 0, ready: 0, blocked: 0, frozen: 0 };
  for (const node of nodes.values()) {
    if (!isEpic(node.bead) && node.state !== "done") counts[node.state] += 1;
  }
  // Counted from the scope, so the total stays put when completed work is hidden.
  counts.done = new Set(
    scoped
      .filter((bead) => bead.status === "closed" && !isEpic(bead) && !isArchived(bead))
      .map((bead) => bead.id),
  ).size;

  const shownEdges = edges.filter((edge) => !collapsed.has(edge.from) && !collapsed.has(edge.to));
  return {
    columns: orderColumns(columns, shownEdges),
    edges: shownEdges,
    longestChain,
    counts,
    cycles: components.filter((members) => members.length > 1).length,
    unlinkedCount: unlinked.length,
    hiddenUnlinked,
  };
}

/** Everything a bead waits on and everything waiting on it, closed beads included. */
export function lineage(map: DepthMap, id: string): { up: Set<string>; down: Set<string> } {
  const prerequisites = new Map<string, string[]>();
  const dependents = new Map<string, string[]>();
  for (const edge of map.edges) {
    pushTo(prerequisites, edge.to, edge.from);
    pushTo(dependents, edge.from, edge.to);
  }
  const walk = (links: Map<string, string[]>) => {
    const seen = new Set<string>();
    const pending = [id];
    while (pending.length) {
      for (const next of links.get(pending.pop()!) ?? []) {
        if (seen.has(next)) continue;
        seen.add(next);
        pending.push(next);
      }
    }
    seen.delete(id);
    return seen;
  };
  return { up: walk(prerequisites), down: walk(dependents) };
}

export const NODE_WIDTH = 188;
export const NODE_HEIGHT = 74;
const COLUMN_PITCH = 236;
const ROW_PITCH = 86;
const ROW_GAP = ROW_PITCH - NODE_HEIGHT;
const PAD_X = 16;
const PAD_TOP = 12;
const PAD_BOTTOM = 16;
/** How far a link inside a cycle bows out of the right side of its column. */
const CYCLE_BOW = 34;
const FOOT_HEIGHT = 32;

export interface DepthMapLayout {
  nodes: Map<string, { x: number; y: number }>;
  /** Edge id to SVG path. */
  paths: Map<string, string>;
  columnX: number[];
  /** Where the control below the first column goes. */
  footY: number;
  width: number;
  height: number;
}

export function layoutDepthMap(map: DepthMap): DepthMapLayout {
  const nodes = new Map<string, { x: number; y: number }>();
  const columnX = map.columns.map((_, column) => PAD_X + column * COLUMN_PITCH);
  let rows = 0;
  map.columns.forEach((column, c) => {
    rows = Math.max(rows, column.length);
    column.forEach((node, r) => nodes.set(node.bead.id, { x: columnX[c], y: PAD_TOP + r * ROW_PITCH }));
  });

  const footY = PAD_TOP + (map.columns[0]?.length ?? 0) * ROW_PITCH;
  const curve = (x1: number, y1: number, x2: number, y2: number) => {
    const middle = (x1 + x2) / 2;
    return `C${middle},${y1} ${middle},${y2} ${x2},${y2}`;
  };
  // The gap between rows nearest to y. Links that skip a column run along these,
  // because a link passing behind a node reads as ending there.
  const gutter = (y: number) => {
    const row = Math.max(0, Math.round((y - PAD_TOP + ROW_GAP / 2) / ROW_PITCH));
    return PAD_TOP + row * ROW_PITCH - ROW_GAP / 2;
  };

  const paths = new Map<string, string>();
  for (const edge of map.edges) {
    const from = nodes.get(edge.from)!;
    const to = nodes.get(edge.to)!;
    const y1 = from.y + NODE_HEIGHT / 2;
    const y2 = to.y + NODE_HEIGHT / 2;
    const right = from.x + NODE_WIDTH;
    if (from.x === to.x) {
      paths.set(edge.id, `M${right},${y1} C${right + CYCLE_BOW},${y1} ${right + CYCLE_BOW},${y2} ${right},${y2}`);
      continue;
    }
    let path = `M${right},${y1}`;
    let x = right;
    let y = y1;
    for (const left of columnX) {
      if (left <= from.x || left >= to.x) continue;
      const lane = gutter(y1 + ((y2 - y1) * (left - right)) / (to.x - right));
      path += ` ${curve(x, y, left, lane)} L${left + NODE_WIDTH},${lane}`;
      x = left + NODE_WIDTH;
      y = lane;
    }
    paths.set(edge.id, `${path} ${curve(x, y, to.x, y2)}`);
  }

  return {
    nodes,
    paths,
    columnX,
    footY,
    width: columnX.length ? columnX[columnX.length - 1] + NODE_WIDTH + PAD_X + CYCLE_BOW : 0,
    height: Math.max(PAD_TOP + (rows - 1) * ROW_PITCH + NODE_HEIGHT, footY + FOOT_HEIGHT) + PAD_BOTTOM,
  };
}
