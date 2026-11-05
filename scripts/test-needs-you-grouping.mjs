// Needs You grouping, sorting and the unblocked toggle against isolated fixtures.
import assert from "node:assert/strict";
import { chromium } from "playwright";

const base = process.env.SCOTTY_TEST_URL;
assert.ok(base, "Set SCOTTY_TEST_URL to an isolated demo server");
const shot = process.env.SCOTTY_TEST_SCREENSHOT;

const bead = (id, extra = {}) => ({
  id,
  title: `Title ${id}`,
  status: "open",
  issue_type: "task",
  priority: 2,
  labels: [],
  dependencies: [],
  created_at: "2026-09-01T00:00:00Z",
  updated_at: "2026-09-01T00:00:00Z",
  ...extra,
});
const dep = (type, target) => ({ type, depends_on_id: target });
const child = (parent, ...more) => [dep("parent-child", parent), ...more];
const human = ["human"];

const fixtures = [
  bead("epic-a", { issue_type: "epic", title: "Launch epic" }),
  bead("epic-b", { issue_type: "epic", title: "Billing epic" }),
  bead("feature-p", { issue_type: "feature", title: "Plain parent" }),
  bead("done-a", { status: "closed", dependencies: child("epic-a") }),
  bead("upstream", { title: "Upstream work" }),
  // Ready question in epic-a, holding up two open beads (one transitively).
  bead("q-ready", { labels: human, priority: 3, updated_at: "2026-09-05T00:00:00Z", dependencies: child("epic-a") }),
  bead("waits-1", { dependencies: [dep("blocks", "q-ready")] }),
  bead("waits-2", { dependencies: [dep("waits-for", "waits-1")] }),
  bead("waits-closed", { status: "closed", dependencies: [dep("blocks", "q-ready")] }),
  // Blocked question in epic-a.
  bead("q-blocked", { labels: human, priority: 0, updated_at: "2026-09-02T00:00:00Z", dependencies: child("epic-a", dep("blocks", "upstream")) }),
  // Ready gate in epic-b.
  bead("g-ready", { issue_type: "gate", await_type: "human", priority: 1, updated_at: "2026-09-03T00:00:00Z", dependencies: child("epic-b") }),
  // Blocked gate under a non-epic parent; today's inbox would hide this one.
  bead("g-blocked", { issue_type: "gate", await_type: "human", priority: 2, updated_at: "2026-09-04T00:00:00Z", dependencies: child("feature-p", dep("blocks", "upstream")) }),
  // No parent at all.
  bead("q-orphan", { labels: human, priority: 4, updated_at: "2026-09-01T00:00:00Z" }),
];

const browser = await chromium.launch();
let page;
try {
  const context = await browser.newContext({ viewport: { width: 1400, height: 1000 } });
  page = await context.newPage();
  page.setDefaultTimeout(10_000);
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  let beads = fixtures;

  await page.route("**/api/p/demo/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith("/beads/stream")) return route.abort();
    if (path.endsWith("/beads")) {
      return route.fulfill({
        json: {
          beads,
          meta: { kind: "demo", humanActor: "reviewer", humanAllowlist: ["reviewer"], pollIntervalMs: 300_000 },
        },
      });
    }
    return route.fulfill({ json: beads.find((b) => path.endsWith(`/beads/${b.id}`)) ?? {} });
  });

  await page.goto(`${base}/p/demo?view=needsyou`);
  await context.request.put(`${base}/api/viewer-mode`, { data: { readOnly: false } });
  await page.reload();
  await page.getByRole("button", { name: "Read Only Mode", exact: true }).waitFor({ state: "detached" });
  await page.locator('[data-keyboard-bead-id="q-ready"]').waitFor();

  const sections = () => page.locator("section:has(h2)").evaluateAll((list) =>
    list.map((s) => ({
      heading: s.querySelector("h2")?.textContent?.trim(),
      items: [...s.querySelectorAll("[data-keyboard-bead-id]")].map((e) => e.dataset.keyboardBeadId),
    })),
  );
  const flat = async () => (await sections()).flatMap((s) => s.items);
  // The URL leads the render by a tick, so order checks retry until they settle.
  const settled = async (read, expected) => {
    for (let i = 0; i < 40; i += 1) {
      try { return assert.deepEqual(await read(), expected); } catch { await page.waitForTimeout(50); }
    }
    assert.deepEqual(await read(), expected);
  };
  const sort = page.getByLabel("Sort by");
  const all = page.getByRole("button", { name: "All", exact: true });
  const unblocked = page.getByRole("button", { name: "Unblocked only", exact: true });
  const header = page.getByRole("heading", { name: "Needs You", exact: true }).locator("xpath=following-sibling::span");

  // Grouping: nearest parent of any type, priority order, "No epic" last.
  assert.deepEqual(await sections(), [
    { heading: "Launch epic", items: ["q-blocked", "q-ready"] },
    { heading: "Billing epic", items: ["g-ready"] },
    { heading: "Plain parent", items: ["g-blocked"] },
    { heading: "No epic", items: ["q-orphan"] },
  ]);
  assert.match(await header.textContent(), /5 waiting on you · 2 blocked/);
  const epicSection = page.locator("section").filter({ has: page.getByRole("heading", { name: "Launch epic" }) });
  await epicSection.getByText("1/3 done", { exact: true }).waitFor();
  await epicSection.getByText("2 waiting", { exact: true }).waitFor();
  const plainSection = page.locator("section").filter({ has: page.getByRole("heading", { name: "Plain parent" }) });
  assert.equal(await plainSection.getByText(/ done$/).count(), 0, "only epics show progress");

  // Group titles open the parent.
  await page.getByRole("button", { name: "Launch epic", exact: true }).click();
  await page.waitForFunction(() => new URL(location.href).searchParams.get("bead") === "epic-a");
  await page.keyboard.press("Escape");
  await page.waitForFunction(() => !new URL(location.href).searchParams.has("bead"));

  // A blocked gate is listed, names its blocker, and can't be approved.
  const gate = page.locator('[data-keyboard-bead-id="g-blocked"]');
  await gate.getByText("Blocked", { exact: true }).waitFor();
  await gate.getByRole("button", { name: "upstream", exact: true }).waitFor();
  await gate.getByText("This gate can be approved once its blockers are resolved.").waitFor();
  assert.equal(await gate.getByRole("button", { name: "Approve", exact: true }).isDisabled(), true);
  const ready = page.locator('[data-keyboard-bead-id="g-ready"]');
  assert.equal(await ready.getByRole("button", { name: "Approve", exact: true }).isDisabled(), false);
  assert.equal(await ready.getByText("Blocked", { exact: true }).count(), 0);
  // A blocked question can still be answered ahead of time.
  const question = page.locator('[data-keyboard-bead-id="q-blocked"]');
  await question.getByText("Blocked", { exact: true }).waitFor();
  assert.equal(await question.getByRole("textbox").isDisabled(), false);
  // The sidebar badge keeps meaning "actionable": 3 questions + 1 ready gate.
  await page.getByRole("button", { name: /^Needs You\s+4$/ }).waitFor();

  if (shot) await page.screenshot({ path: shot });

  // Each sort orders items in a group and groups by their best item.
  await sort.selectOption("unblocks");
  await page.waitForFunction(() => new URL(location.href).searchParams.get("nysort") === "unblocks");
  // q-ready holds up the most open beads.
  await settled(async () => (await flat()).slice(0, 2), ["q-ready", "q-blocked"]);
  await sort.selectOption("newest");
  await page.waitForFunction(() => new URL(location.href).searchParams.get("nysort") === "newest");
  await settled(flat, ["q-ready", "q-blocked", "g-blocked", "g-ready", "q-orphan"]);
  await sort.selectOption("oldest");
  await page.waitForFunction(() => new URL(location.href).searchParams.get("nysort") === "oldest");
  await settled(flat, ["q-blocked", "q-ready", "g-ready", "g-blocked", "q-orphan"]);

  // The toggle narrows to unblocked items and drops emptied groups.
  await unblocked.click();
  await page.waitForFunction(() => new URL(location.href).searchParams.get("nyshow") === "unblocked");
  await settled(sections, [
    { heading: "Billing epic", items: ["g-ready"] },
    { heading: "Launch epic", items: ["q-ready"] },
    { heading: "No epic", items: ["q-orphan"] },
  ]);
  assert.match(await header.textContent(), /3 of 5 unblocked/);
  assert.equal(await unblocked.getAttribute("aria-pressed"), "true");

  // Both controls survive a reload, and Back restores the previous state.
  await page.reload();
  await page.locator('[data-keyboard-bead-id="q-ready"]').waitFor();
  assert.equal(await sort.inputValue(), "oldest");
  assert.equal(await unblocked.getAttribute("aria-pressed"), "true");
  await page.goBack();
  await page.locator('[data-keyboard-bead-id="g-blocked"]').waitFor();
  assert.equal(await all.getAttribute("aria-pressed"), "true");
  await page.goForward();
  await page.locator('[data-keyboard-bead-id="g-blocked"]').waitFor({ state: "detached" });

  // An unrecognised value falls back, and unrelated parameters are preserved.
  await page.goto(`${base}/p/demo?view=needsyou&nysort=bogus&q=keep`);
  await page.locator('[data-keyboard-bead-id="q-ready"]').waitFor();
  assert.equal(await sort.inputValue(), "priority");
  await sort.selectOption("oldest");
  await page.waitForFunction(() => new URL(location.href).searchParams.get("nysort") === "oldest");
  assert.equal(new URL(page.url()).searchParams.get("q"), "keep");
  await sort.selectOption("priority");
  await page.waitForFunction(() => !new URL(location.href).searchParams.has("nysort"));

  // Keyboard navigation follows the on-screen order across groups.
  await page.goto(`${base}/p/demo?view=needsyou`);
  await page.locator('[data-keyboard-bead-id="q-ready"]').waitFor();
  const order = await flat();
  for (const id of order) {
    await page.keyboard.press("j");
    await page.waitForFunction((want) => document.activeElement?.dataset?.keyboardBeadId === want, id);
  }

  // Mobile width: controls stay reachable and the page doesn't scroll sideways.
  await page.setViewportSize({ width: 390, height: 844 });
  await sort.waitFor();
  await unblocked.waitFor();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
  await page.setViewportSize({ width: 1400, height: 1000 });

  // Read-only: the inbox stays navigable but nothing can be answered or approved.
  await context.request.put(`${base}/api/viewer-mode`, { data: { readOnly: true } });
  await page.reload();
  await page.locator('[data-keyboard-bead-id="g-ready"]').waitFor();
  await page.getByRole("button", { name: "Read Only Mode", exact: true }).waitFor();
  assert.equal(await ready.getByRole("button", { name: "Approve", exact: true }).isDisabled(), true);
  await unblocked.click();
  await page.waitForFunction(() => new URL(location.href).searchParams.get("nyshow") === "unblocked");
  await context.request.put(`${base}/api/viewer-mode`, { data: { readOnly: false } });

  // Everything blocked: a distinct empty state offers the way back.
  beads = fixtures.filter((b) => !["q-ready", "g-ready", "q-orphan"].includes(b.id));
  await page.reload();
  await page.getByText("Everything waiting on you is blocked by other work").waitFor();
  assert.match(await header.textContent(), /0 of 2 unblocked/);
  assert.equal(await page.getByText("Nothing needs you right now").count(), 0);
  await page.getByRole("button", { name: "Show all 2", exact: true }).click();
  await page.locator('[data-keyboard-bead-id="g-blocked"]').waitFor();

  // Nothing at all: the original empty state, with no controls.
  beads = fixtures.filter((b) => !b.labels.includes("human") && b.issue_type !== "gate");
  await page.reload();
  await page.getByText("Nothing needs you right now").waitFor();
  assert.equal(await sort.count(), 0);

  assert.deepEqual(errors, []);
  console.log("Needs You grouping checks passed");
} finally {
  await browser.close();
}
