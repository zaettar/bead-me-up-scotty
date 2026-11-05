// Isolated demo server only; project data and writes are intercepted.
// SCOTTY_TEST_URL=http://127.0.0.1:3000 node scripts/test-drawer-human-response.mjs
import assert from "node:assert/strict";
import { chromium } from "playwright";

const base = process.env.SCOTTY_TEST_URL;
const shot = process.env.SCOTTY_TEST_SCREENSHOT;
assert.ok(base, "Set SCOTTY_TEST_URL to an isolated demo server");

const bead = (id, extra = {}) => ({
  id,
  title: `Title ${id}`,
  description: "Which provider should we use?",
  status: "open",
  issue_type: "task",
  priority: 2,
  labels: [],
  dependencies: [],
  comments: [],
  created_at: "2026-09-01T00:00:00Z",
  updated_at: "2026-09-01T00:00:00Z",
  ...extra,
});
const flagged = (id, extra = {}) => bead(id, { labels: ["human", "keep"], ...extra });
const beads = [
  bead("plain"),
  bead("closed-flag", { status: "closed", labels: ["human"] }),
  bead("upstream"),
  flagged("answer", { status: "in_progress", dependencies: [{ type: "blocks", depends_on_id: "upstream" }] }),
  flagged("skip"),
  flagged("origin", { dependencies: [{ type: "blocks", depends_on_id: "next" }] }),
  flagged("next"),
  flagged("cli"),
  flagged("shortcut"),
  flagged("inbox"),
];
const byId = (id) => beads.find((entry) => entry.id === id);
const writes = [];
let failNext = false;

const browser = await chromium.launch();
try {
  const context = await browser.newContext({ viewport: { width: 1500, height: 1000 } });
  await context.request.put(`${base}/api/viewer-mode`, { data: { readOnly: false } });
  const page = await context.newPage();
  page.setDefaultTimeout(8000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));

  await page.route("**/api/p/demo/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path.endsWith("/beads/stream")) return route.abort();
    if (request.method() === "GET") {
      if (path.endsWith("/beads")) {
        return route.fulfill({
          json: { beads, meta: { kind: "demo", humanActor: "reviewer", humanAllowlist: ["reviewer"], pollIntervalMs: 500 } },
        });
      }
      return route.fulfill({ json: beads.find((entry) => path.endsWith(`/beads/${entry.id}`)) ?? {} });
    }
    const body = request.postDataJSON();
    const id = path.match(/\/beads\/([^/]+)\/human$/)?.[1];
    writes.push({ id, method: request.method(), body });
    if (failNext) {
      failNext = false;
      return route.fulfill({ status: 500, json: { error: "temporary failure" } });
    }
    const target = byId(id);
    if (body.action === "respond") {
      target.comments = [...target.comments, { id: `${id}-c`, author: "reviewer", text: body.text, created_at: "2026-09-02T00:00:00Z" }];
    }
    target.labels = target.labels.filter((label) => label !== "human");
    return route.fulfill({ json: target });
  });

  const dialog = page.getByRole("dialog");
  const callout = dialog.getByText("Needs your input.");
  const field = dialog.getByPlaceholder(/^Answer the agent's question/);
  const respond = dialog.getByRole("button", { name: "Respond", exact: true });
  const dismiss = dialog.getByRole("button", { name: "Dismiss", exact: true });
  const clickOutside = () => page.mouse.click(8, 990);
  const open = async (id) => {
    await page.goto(`${base}/p/demo?bead=${id}`);
    await dialog.getByText(`Title ${id}`).first().waitFor();
  };

  // Only beads still waiting on a person offer the form.
  await open("plain");
  assert.equal(await callout.count(), 0, "an unflagged bead has no callout");
  await open("closed-flag");
  assert.equal(await callout.count(), 0, "a closed bead no longer needs input");

  // A blocked bead still takes an answer, and a failure keeps the text.
  await open("answer");
  await callout.waitFor();
  assert.equal(await respond.isEnabled(), false, "an empty answer cannot be sent");
  await field.fill("  Use Clerk.  ");
  if (shot) {
    await page.waitForTimeout(600); // let the drawer finish sliding in
    await page.screenshot({ path: shot });
  }
  failNext = true;
  await respond.click();
  await page.getByText(/temporary failure/i).waitFor();
  assert.equal(await field.inputValue(), "  Use Clerk.  ", "a failed response preserves the draft");
  await callout.waitFor();

  await respond.click();
  await callout.waitFor({ state: "detached" });
  assert.deepEqual(writes.at(-1), { id: "answer", method: "POST", body: { action: "respond", text: "Use Clerk." } });
  assert.equal(writes.length, 2, "one failed attempt and one retry");
  await dialog.getByText("Use Clerk.", { exact: true }).waitFor();
  assert.equal(byId("answer").status, "in_progress", "responding leaves the status alone");
  assert.deepEqual(byId("answer").labels, ["keep"], "only the human flag is cleared");
  await clickOutside();
  await dialog.waitFor({ state: "detached" }); // the sent answer is no longer unsaved

  // Dismiss clears the request without a comment.
  await open("skip");
  await field.fill("Changed my mind");
  await dismiss.click();
  await callout.waitFor({ state: "detached" });
  assert.deepEqual(writes.at(-1), { id: "skip", method: "POST", body: { action: "dismiss" } });
  assert.equal(byId("skip").comments.length, 0);
  await clickOutside();
  await dialog.waitFor({ state: "detached" });

  // A draft belongs to one bead, and counts as unsaved while it is showing.
  await open("origin");
  await field.fill("Only for origin");
  await clickOutside();
  await page.getByText("You have unsaved changes").waitFor();
  assert.equal(await field.inputValue(), "Only for origin", "a draft survives a stray click");
  await dialog.getByRole("button", { name: /Title next/ }).click();
  await dialog.getByText("Title next").first().waitFor();
  await callout.waitFor();
  assert.equal(await field.inputValue(), "", "a draft does not follow the drawer to another bead");

  // The flag cleared elsewhere: the hidden draft must not pin the drawer open.
  await open("cli");
  await field.fill("Typed before the agent moved on");
  byId("cli").labels = [];
  await callout.waitFor({ state: "detached" });
  await clickOutside();
  await dialog.waitFor({ state: "detached" });

  // App shortcuts stay out of the field, and Cmd/Ctrl+Enter submits.
  await open("shortcut");
  await field.focus();
  await page.keyboard.type("ney");
  assert.equal(await field.inputValue(), "ney", "shortcut keys type into the field");
  assert.equal(await page.getByPlaceholder("What needs doing?").count(), 0, "n does not open the create dialog");
  await page.keyboard.press("ControlOrMeta+Enter");
  await callout.waitFor({ state: "detached" });
  assert.deepEqual(writes.at(-1).body, { action: "respond", text: "ney" });

  // The inbox uses the same form.
  await page.goto(`${base}/p/demo`);
  await page.getByRole("button", { name: /^Needs You(?:\s+\d+)?$/ }).click();
  const card = page.locator('[data-keyboard-bead-id="inbox"]');
  await card.getByPlaceholder(/^Answer the agent's question/).fill("From the inbox");
  await card.getByRole("button", { name: "Respond", exact: true }).click();
  await card.waitFor({ state: "detached" });
  assert.deepEqual(writes.at(-1), { id: "inbox", method: "POST", body: { action: "respond", text: "From the inbox" } });

  // Read-only keeps the request visible but offers no way to act on it.
  await context.request.put(`${base}/api/viewer-mode`, { data: { readOnly: true } });
  await open("next");
  await callout.waitFor();
  assert.equal(await field.isDisabled(), true);
  assert.equal(await dismiss.isDisabled(), true);
  assert.equal(await respond.isDisabled(), true);

  assert.deepEqual(errors, []);
  console.log("Drawer human response checks passed.");
} finally {
  await browser.close();
}
