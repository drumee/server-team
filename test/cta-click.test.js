// test/cta-click.test.js
const assert = require("assert");

let failures = 0;
function test(name, fn) {
  try { fn(); console.log(`  ok   ${name}`); }
  catch (e) { failures++; console.log(`  FAIL ${name}\n       ${e.message}`); }
}

const { ctaFeature, CTA_FEATURES } = require("../service/lib/cta-click");

test("maps the two accepted CTAs to their feature keys", () => {
  assert.strictEqual(ctaFeature("upgrade"), "upgrade_click");
  assert.strictEqual(ctaFeature("selfhosted"), "selfhosted_click");
});

test("rejects an unknown cta rather than building a key from it", () => {
  assert.strictEqual(ctaFeature("upgrad"), null, "a typo must not reach feature_mark");
  assert.strictEqual(ctaFeature("chat"), null, "an existing feature name is not a CTA");
  assert.strictEqual(ctaFeature(""), null);
  assert.strictEqual(ctaFeature(null), null);
  assert.strictEqual(ctaFeature(undefined), null);
});

test("is not fooled by type coercion", () => {
  assert.strictEqual(ctaFeature(0), null);
  assert.strictEqual(ctaFeature({}), null);
  assert.strictEqual(ctaFeature(["upgrade"]), null);
});

test("the exported list is exactly the two accepted values", () => {
  assert.deepStrictEqual(CTA_FEATURES.slice().sort(), ["selfhosted", "upgrade"]);
});

console.log(failures ? `\n${failures} failure(s)` : "\nall passed");
process.exit(failures ? 1 : 0);
