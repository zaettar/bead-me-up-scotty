// Roadmap model and layout. Pure logic on fixtures: no browser, no project data.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import vm from "node:vm";
import ts from "typescript";

const require = createRequire(import.meta.url);
const cache = new Map();
function load(name) {
  if (cache.has(name)) return cache.get(name);
  const exports = {};
  cache.set(name, exports);
  const code = ts.transpileModule(readFileSync(new URL(`../lib/${name}.ts`, import.meta.url), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  vm.runInNewContext(code, {
    exports,
    require: (id) => (id.startsWith("./") ? load(id.slice(2)) : require(id)),
  });
  return exports;
}
const { buildDepthMap, layoutDepthMap, lineage, NODE_WIDTH, NODE_HEIGHT } = load("depth-map");
const { graphDependencyLayers } = load("graph-epic");
const { FLOW_DEP_TYPES } = load("schema");

const bead = (id, extra = {}) => ({
  id, title: id, status: "open", issue_type: "task", priority: 2, labels: [], dependencies: [],
  created_at: "2026-09-01T00:00:00Z", updated_at: "2026-09-01T00:00:00Z", ...extra,
});
const dep = (target, type = "blocks") => ({ depends_on_id: target, type });
const needs = (...targets) => ({ dependencies: targets.map((t) => dep(t)) });
const shown = { showUnlinked: true };
const node = (map, id) => map.columns.flat().find((n) => n.bead.id === id);
const depths = (map) => Object.fromEntries(map.columns.flat().map((n) => [n.bead.id, n.depth]));
const plain = (value) => JSON.parse(JSON.stringify(value));
const ids = (map) => plain(map.columns.flat().map((n) => n.bead.id).sort());
const shuffle = (list, seed) => {
  const copy = [...list];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    const j = seed % (i + 1);
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
};

// parent-child adds no depth, and Graph's default keeps counting it.
{
  const beads = [bead("epic", { issue_type: "epic" }), bead("child", { dependencies: [dep("epic", "parent-child")] })];
  assert.equal(graphDependencyLayers(beads).get("child"), 1, "default layers still follow hierarchy");
  assert.equal(graphDependencyLayers(beads, FLOW_DEP_TYPES).get("child"), 0);
  assert.equal(node(buildDepthMap(beads, shown), "child").depth, 0);
}

// State table, including in progress beating blocked.
{
  const map = buildDepthMap([
    bead("root", { status: "in_progress" }),
    bead("closed", { status: "closed" }),
    bead("hooked", { status: "hooked", ...needs("root") }),
    bead("waiting", needs("root")),
    bead("manual", { status: "blocked" }),
    bead("met", needs("closed")),
    bead("frozen", { status: "deferred" }),
    bead("frozen-dependent", needs("frozen")),
    bead("pin", { status: "pinned" }),
    bead("pin-dependent", needs("pin")),
  ], shown);
  const expected = {
    root: "doing", closed: "done", hooked: "doing", waiting: "blocked", manual: "blocked",
    met: "ready", frozen: "frozen", pin: "frozen",
  };
  for (const [id, state] of Object.entries(expected)) assert.equal(node(map, id).state, state, id);
}

// Completed work stays in place by default and leaves when hidden.
{
  const beads = [bead("a", { status: "closed" }), bead("b", needs("a")), bead("c", needs("b"))];
  const kept = buildDepthMap(beads);
  assert.deepEqual(depths(kept), { a: 0, b: 1, c: 2 });
  assert.equal(kept.edges.find((e) => e.from === "a").met, true);
  assert.equal(kept.edges.find((e) => e.from === "b").met, false);
  const hidden = buildDepthMap(beads, { hideCompleted: true });
  assert.deepEqual(depths(hidden), { b: 0, c: 1 }, "a bead reaches NO BLOCKERS once its blockers close");
  assert.equal(hidden.counts.done, 1, "the done count survives hiding");
  assert.equal(kept.counts.done, 1);
}

// Deferred blockers stay visible; archived blockers become hidden chips.
{
  const map = buildDepthMap([
    bead("open-archived", { labels: ["archived"] }),
    bead("closed-archived", { status: "closed", labels: ["archived"] }),
    bead("deferred", { status: "deferred" }),
    bead("deferred-root", { status: "deferred" }),
    bead("deferred-chain", { status: "deferred", ...needs("deferred-root") }),
    bead("idle", { status: "deferred" }),
    bead("waiting", needs("deferred", "deferred-chain", "open-archived", "closed-archived")),
  ], shown);
  assert.deepEqual(ids(map), ["deferred", "deferred-chain", "deferred-root", "waiting"]);
  assert.deepEqual(plain(node(map, "waiting").hiddenBlockers), ["open-archived"]);
  const closedDependent = buildDepthMap([bead("deferred", { status: "deferred" }), bead("done", { status: "closed", ...needs("deferred") })], shown);
  assert.deepEqual(ids(closedDependent), ["done"], "only unfinished work pulls a frozen bead in");
}

// A dangling id counts as an unfinished blocker.
{
  const map = buildDepthMap([bead("waiting", needs("gone"))], shown);
  assert.deepEqual(plain(node(map, "waiting").hiddenBlockers), ["gone"]);
  assert.equal(node(map, "waiting").state, "blocked");
  assert.equal(map.edges.length, 0);
}

// Epics appear only with a depth edge.
{
  const map = buildDepthMap([
    bead("plain-epic", { issue_type: "epic" }),
    bead("child", { dependencies: [dep("plain-epic", "parent-child")] }),
    bead("linked-epic", { issue_type: "epic" }),
    bead("after-epic", needs("linked-epic")),
  ], shown);
  assert.deepEqual(ids(map), ["after-epic", "child", "linked-epic"]);
  assert.equal(node(map, "child").epic.id, "plain-epic");
  assert.equal(node(map, "linked-epic").rank, undefined, "an epic is never next up");
  assert.equal(map.counts.ready, 1, "epics are not counted as work");
}

// Cycles share a column, are flagged, and don't depend on input order.
{
  const beads = [
    bead("before"),
    bead("a", { dependencies: [dep("b"), dep("before")] }),
    bead("b", needs("c")),
    bead("c", needs("a")),
    bead("after", needs("b")),
  ];
  const map = buildDepthMap(beads);
  assert.equal(map.cycles, 1);
  assert.deepEqual(depths(map), { before: 0, a: 1, b: 1, c: 1, after: 2 });
  for (const id of ["a", "b", "c"]) assert.equal(node(map, id).inCycle, true, id);
  assert.equal(node(map, "after").inCycle, false);
  assert.equal(map.longestChain, 5, "a cycle weighs its open members");
  for (let seed = 1; seed < 6; seed += 1) {
    assert.deepEqual(plain(buildDepthMap(shuffle(beads, seed)).columns.map((c) => c.map((n) => n.bead.id))),
      plain(map.columns.map((c) => c.map((n) => n.bead.id))));
  }
  const layout = layoutDepthMap(map);
  const cycleEdge = map.edges.find((e) => e.from === "a" && e.to === "c");
  const right = layout.nodes.get("a").x + NODE_WIDTH;
  assert.match(layout.paths.get(cycleEdge.id), new RegExp(`^M${right},.* ${right},`), "same-column links leave and enter on the right");
}

// A 2,500-deep chain completes without overflow.
{
  const chain = Array.from({ length: 2500 }, (_, i) => bead(`n${i}`, i ? needs(`n${i - 1}`) : {}));
  const map = buildDepthMap(chain);
  assert.equal(map.columns.length, 2500);
  assert.equal(map.longestChain, 2500);
  assert.equal(lineage(map, "n1200").up.size, 1200);
  assert.equal(node(map, "n0").unblocks, 2499);
  assert.equal(layoutDepthMap(map).nodes.size, 2500);
}

// Critical path: tied chains stay separate, and one step is not a chain.
{
  const map = buildDepthMap([
    bead("a1"), bead("a2", needs("a1")),
    bead("b1"), bead("b2", needs("b1")),
    bead("shared", { dependencies: [dep("a2"), dep("b1")] }),
    bead("short"), bead("short-end", needs("short")),
  ]);
  assert.equal(map.longestChain, 3);
  for (const id of ["a1", "a2", "shared"]) assert.equal(node(map, id).critical, true, id);
  assert.equal(node(map, "short").critical, false);
  const edge = (from, to) => map.edges.find((e) => e.from === from && e.to === to);
  assert.equal(edge("a2", "shared").critical, true);
  assert.equal(edge("b1", "shared").critical, false, "b1 -> shared is only two steps");

  const tied = buildDepthMap([
    bead("x1"), bead("y1"),
    bead("x2", needs("x1")), bead("y2", needs("y1")),
    bead("x3", needs("x2")), bead("y3", needs("y2", "x1")),
  ]);
  const tiedEdge = (from, to) => tied.edges.find((e) => e.from === from && e.to === to);
  assert.equal(node(tied, "x1").critical && node(tied, "y3").critical, true);
  assert.equal(tiedEdge("x1", "y3").critical, false, "an edge between two tied chains is not on either");

  const solo = buildDepthMap([bead("one"), bead("two")], shown);
  assert.equal(solo.longestChain, 1);
  assert.equal(solo.columns.flat().some((n) => n.critical), false, "independent beads are never critical");
}

// Rank covers actionable beads only, and 0 is the most urgent priority.
{
  const map = buildDepthMap([
    bead("doing", { status: "in_progress" }),
    bead("urgent", { priority: 0, ...needs("doing") }),
    bead("later", { priority: 3 }), bead("later-end", needs("later")),
    bead("sooner", { priority: 0 }), bead("sooner-end", { priority: 4, ...needs("sooner") }),
    bead("gate", { issue_type: "gate", await_type: "human" }), bead("gated", needs("gate")),
    bead("question", { labels: ["human"] }), bead("question-end", needs("question")),
  ]);
  assert.equal(node(map, "doing").rank, undefined);
  assert.equal(node(map, "gate").rank, undefined);
  assert.equal(node(map, "gate").needsYou, true);
  assert.equal(node(map, "question").rank, undefined);
  assert.equal(node(map, "question").needsYou, true);
  assert.equal(node(map, "sooner").rank, 1);
  assert.equal(node(map, "later").rank, 2);
  const ranks = map.columns.flat().map((n) => n.rank).filter(Boolean).sort();
  assert.deepEqual(plain(ranks), [1, 2], "ranks have no holes");
}

// Unblocks counts open beads, and doesn't pass through finished work.
{
  const map = buildDepthMap([
    bead("root"),
    bead("mid", needs("root")),
    bead("end", needs("mid")),
    bead("finished", { status: "closed", ...needs("root") }),
    bead("past-finished", needs("finished")),
  ]);
  assert.equal(node(map, "root").unblocks, 2);
  assert.equal(node(map, "finished").unblocks, 0);
}

// Unlinked beads collapse, and never hold a rank.
{
  const beads = [bead("alone"), bead("alone-done", { status: "closed" }), bead("a"), bead("b", needs("a"))];
  const map = buildDepthMap(beads);
  assert.deepEqual(ids(map), ["a", "b"]);
  assert.deepEqual(plain(map.hiddenUnlinked), ["alone", "alone-done"]);
  assert.equal(map.counts.ready, 2, "collapsed beads still count");
  assert.equal(node(buildDepthMap(beads, shown), "alone").rank, 1 + 1);
}

// Epic scope keeps one hop of outside context, flagged as such.
{
  const map = buildDepthMap([
    bead("epic", { issue_type: "epic" }),
    bead("inside", { dependencies: [dep("epic", "parent-child"), dep("outside")] }),
    bead("outside"),
    bead("unrelated"),
  ], { epicId: "epic", ...shown });
  assert.deepEqual(ids(map), ["inside", "outside"]);
  assert.equal(node(map, "outside").outsideEpic, true);
  assert.equal(node(map, "inside").outsideEpic, false);
}

// Lineage follows closed beads too.
{
  const map = buildDepthMap([bead("a", { status: "closed" }), bead("b", needs("a")), bead("c", needs("b")), bead("d", needs("a"))]);
  const { up, down } = lineage(map, "b");
  assert.deepEqual(plain([...up]), ["a"]);
  assert.deepEqual(plain([...down]), ["c"]);
}

// Output is identical for shuffled input, and ordering reduces crossings.
{
  const beads = [];
  for (let i = 0; i < 8; i += 1) beads.push(bead(`l${i}`));
  const order = [5, 2, 7, 0, 3, 6, 1, 4];
  order.forEach((target, i) => beads.push(bead(`r${i}`, needs(`l${target}`))));
  const map = buildDepthMap(beads);
  const place = (m) => plain(m.columns.map((c) => c.map((n) => n.bead.id)));
  for (let seed = 1; seed < 8; seed += 1) {
    const shuffled = buildDepthMap(shuffle(beads, seed));
    assert.deepEqual(place(shuffled), place(map));
    assert.deepEqual(plain(shuffled.edges), plain(map.edges));
  }
  const rowOf = (columns) => new Map(columns.flatMap((c) => c.map((id, r) => [id, r])));
  const crossings = (columns) => {
    const rows = rowOf(columns);
    const pairs = map.edges.map((e) => [rows.get(e.from), rows.get(e.to)]);
    let total = 0;
    for (let i = 0; i < pairs.length; i += 1) {
      for (let j = i + 1; j < pairs.length; j += 1) {
        if ((pairs[i][0] - pairs[j][0]) * (pairs[i][1] - pairs[j][1]) < 0) total += 1;
      }
    }
    return total;
  };
  const sorted = place(map).map((c) => [...c].sort());
  assert.ok(crossings(place(map)) < crossings(sorted), `${crossings(place(map))} crossings should beat ${crossings(sorted)}`);
}

// No two nodes overlap, and links meet their nodes.
{
  const beads = Array.from({ length: 60 }, (_, i) => bead(`n${i}`, i > 5 ? needs(`n${i % 6}`, `n${Math.max(0, i - 7)}`) : {}));
  const map = buildDepthMap(beads, shown);
  const layout = layoutDepthMap(map);
  const boxes = [...layout.nodes.values()];
  for (let i = 0; i < boxes.length; i += 1) {
    for (let j = i + 1; j < boxes.length; j += 1) {
      const apart = Math.abs(boxes[i].x - boxes[j].x) >= NODE_WIDTH || Math.abs(boxes[i].y - boxes[j].y) >= NODE_HEIGHT;
      assert.ok(apart, "nodes overlap");
    }
  }
  for (const edge of map.edges) {
    const from = layout.nodes.get(edge.from);
    assert.ok(layout.paths.get(edge.id).startsWith(`M${from.x + NODE_WIDTH},${from.y + NODE_HEIGHT / 2} `));
  }
  assert.ok(boxes.every((b) => b.x + NODE_WIDTH <= layout.width && b.y + NODE_HEIGHT <= layout.height));
}

// A link that skips a column runs along a gap, never behind a node.
{
  const map = buildDepthMap([
    bead("a"), bead("b", needs("a")), bead("b2", needs("a")), bead("b3", needs("a")),
    bead("c", needs("b", "b2", "b3", "a")),
  ]);
  const layout = layoutDepthMap(map);
  const skip = map.edges.find((e) => e.from === "a" && e.to === "c");
  const lanes = [...layout.paths.get(skip.id).matchAll(/L[\d.]+,([\d.]+)/g)].map((m) => Number(m[1]));
  assert.equal(lanes.length, 1, "one lane per column skipped");
  for (const id of ["b", "b2", "b3"]) {
    const { y } = layout.nodes.get(id);
    assert.ok(lanes[0] < y || lanes[0] > y + NODE_HEIGHT, `lane ${lanes[0]} crosses ${id} at ${y}`);
  }
}

// Timing at 500 beads.
{
  const beads = Array.from({ length: 500 }, (_, i) => bead(`t${i}`, {
    priority: i % 5,
    status: i % 4 === 0 ? "closed" : "open",
    dependencies: i > 20 ? [dep(`t${i - 1 - (i % 17)}`), dep(`t${i - 3 - (i % 13)}`)] : [],
  }));
  buildDepthMap(beads);
  const start = performance.now();
  const runs = 10;
  for (let i = 0; i < runs; i += 1) layoutDepthMap(buildDepthMap(beads));
  const ms = (performance.now() - start) / runs;
  console.log(`500 beads: ${ms.toFixed(1)}ms per model and layout`);
  assert.ok(ms < 50, `model took ${ms.toFixed(1)}ms`);
}

console.log("Depth map model checks passed");
