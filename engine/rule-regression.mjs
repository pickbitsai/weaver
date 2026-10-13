// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Mark Pickering and PICKBITS LLC. Part of PickBits Weaver.
const numberText = (value) => value.toLocaleString("en-US", { maximumFractionDigits: 6 });

function measurementChange(rule, before, after) {
  let detail = `the count from ${before?.count ?? 0} to ${after.count}`;
  if (rule.type === "count-per-words") {
    detail += ` (rate from ${numberText(before?.value ?? 0)} to ${numberText(after.value)} per ${numberText(rule.per_words)} words; limit ${numberText(rule.max)} per ${numberText(rule.per_words)} words)`;
  } else if (rule.type === "sentence-start-share") {
    detail += ` (sentence share from ${numberText((before?.value ?? 0) * 100)}% to ${numberText(after.value * 100)}%; limit ${numberText(rule.max_share * 100)}%)`;
  } else {
    detail += ` (limit ${after.limit})`;
  }
  return detail;
}

export function blockingRuleRegression(rules, before, after) {
  for (const rule of rules.filter((rule) => rule.severity === "block")) {
    const previous = before.findings.filter((finding) => finding.rule_id === rule.id);
    const proposed = after.findings.filter((finding) => finding.rule_id === rule.id);
    if (!proposed.length) continue;
    // Rank measured units by severity so inserting a paragraph cannot turn an
    // unchanged finding into a regression just by moving its paragraph number.
    // Compare each rank, not just the maximum or total. Findings come first:
    // a short paragraph below min_sentences must not mask a worsening finding.
    const measurements = (result) => result.measurements.filter((item) => item.rule_id === rule.id)
      .sort((a, b) => Number(b.exceeded) - Number(a.exceeded) || b.value - a.value);
    const oldMeasurements = measurements(before);
    const newMeasurements = measurements(after).filter((item) => item.exceeded);
    const increased = newMeasurements.findIndex((item, index) => item.value > (oldMeasurements[index]?.value ?? 0));
    const change = increased >= 0
      ? measurementChange(rule, oldMeasurements[increased], newMeasurements[increased])
      : proposed.length > previous.length ? `blocking findings from ${previous.length} to ${proposed.length}` : null;
    if (change) return `${rule.id}: ${rule.message} This edit would change ${change}. Blocking rules can't be waived by the AI; if this is intended, ask the author to rule on it.`;
  }
  return null;
}

