// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Mark Pickering and PICKBITS LLC. Part of PickBits Weaver.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { runHost } from "./host.mjs";
import { loadScenes } from "./manuscript.mjs";
import { writeRecord } from "./records.mjs";
import { repairChapter, repairInputs, readProposal, proposalIsStale } from "./repair.mjs";
import { buildReviewPacket, listLenses, reviewInputs, reviewIsCurrent, reviewRecordPath, submitReviewPacket } from "./review.mjs";
import { runRules } from "./rules.mjs";
import { bootstrapState } from "./state.mjs";
import { buildVoiceProfiles } from "./voice.mjs";

export function latestBookRun(root) {
  const directory = join(root, ".weaver", "runs");
  if (!existsSync(directory)) return null;
  const name = readdirSync(directory).filter((item) => item.endsWith(".json")).sort().at(-1);
  return name ? JSON.parse(readFileSync(join(directory, name), "utf8")) : null;
}

export async function runBook(root, project, { throughChapter = null, run = false,
  host = runHost, sleep = delay, onProgress = (line) => process.stdout.write(`${line}\n`), onRecord = () => {} } = {}) {
  const allScenes = loadScenes(root, project);
  if (throughChapter !== null && (!Number.isInteger(Number(throughChapter)) || !allScenes.some((scene) => scene.chapter === Number(throughChapter)))) throw new Error("Choose an existing through-chapter number.");
  const scenes = allScenes.filter((scene) => throughChapter === null || scene.chapter <= Number(throughChapter));
  const chapters = [...new Set(scenes.map((scene) => scene.chapter))];
  const waits = project.run?.retry?.delays_seconds ?? [30, 120];
  if (!Array.isArray(waits) || waits.length !== 2 || waits.some((seconds) => !Number.isFinite(seconds) || seconds < 0)) throw new Error("project.run.retry.delays_seconds must contain two non-negative waits.");
  const started = Date.now();
  const record = { started_at: new Date(started).toISOString(), status: "running", through_chapter: throughChapter, units: [] };
  const path = join(root, ".weaver", "runs", `${record.started_at.replaceAll(":", "-")}-${randomUUID()}.json`);
  const persist = () => { record.total_seconds = (Date.now() - started) / 1000; writeRecord(path, record); onRecord(record, path); };
  persist();
  async function unit(name, action) {
    const began = Date.now();
    const entry = { unit: name, status: "running", started_at: new Date(began).toISOString(), seconds: 0, attempts: 0, error: null, calls: [] };
    record.units.push(entry);
    persist();
    const retryHost = async (bookRoot, configuration, prompt) => {
      for (let attempt = 0; attempt <= waits.length; attempt++) {
        entry.attempts++;
        let response;
        try { response = await host(bookRoot, configuration, prompt, { attempts: 1 }); }
        catch (error) { error.interrupted = true; throw error; }
        entry.calls.push({ attempt: entry.attempts, ok: response.ok, seconds: response.seconds ?? null, error: response.error || null });
        persist();
        if (response.ok) return response;
        if (attempt === waits.length || !/timed out|timeout|exited with|could not start host/iu.test(response.error || "")) return response;
        entry.calls.at(-1).retry_wait_seconds = waits[attempt];
        onProgress(`${name}: host call failed; retrying in ${waits[attempt]} seconds`);
        persist();
        await sleep(waits[attempt] * 1000);
      }
    };
    try { Object.assign(entry, await action(retryHost)); }
    catch (error) {
      entry.status = error.interrupted ? "interrupted" : "failed";
      entry.error = error.message || String(error);
      if (error.interrupted) { record.status = "interrupted"; throw error; }
    } finally {
      entry.seconds = (Date.now() - began) / 1000;
      persist();
      onProgress(`${name}: ${entry.status === "skipped" ? "skipped, already current" : entry.status}${entry.error ? `: ${entry.error}` : ""}`);
    }
  }
  await unit("check", async () => {
    const rules = runRules(root, project, { sceneIds: scenes.map((scene) => scene.id) });
    return { status: "checked", chapters: chapters.length, blocking: rules.blocking, warnings: rules.warnings };
  });
  await unit("voices build", async () => { const voices = buildVoiceProfiles(root, project); return { status: "recorded", profiles: voices.profiles.length }; });
  for (const scene of scenes) await unit(`scene ${scene.id}`, async (retryHost) => {
    let result;
    await bootstrapState(root, project, { sceneIds: [scene.id], run, host: retryHost, onProgress: () => {}, onUnit: (value) => { result = value; } });
    return result;
  });
  for (const chapter of chapters) for (const lens of listLenses(root)) await unit(`chapter ${chapter} review ${lens.id}`, async (retryHost) => {
    const inputs = reviewInputs(root, project, chapter);
    const packet = buildReviewPacket(root, project, chapter, lens.id, inputs);
    const path = reviewRecordPath(root, chapter, lens.id);
    const existing = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : null;
    if (reviewIsCurrent(existing, inputs, packet)) return { status: "skipped" };
    writeRecord(join(root, ".weaver", "packets", `${packet.id}.json`), packet);
    if (!run) return { status: "packet", packet_id: packet.id };
    const response = await retryHost(root, project, packet.prompt);
    if (!response.ok) return { status: "failed", error: response.error };
    const result = await submitReviewPacket(root, project, packet, response.text, { host: retryHost });
    const warnings = result.record?.warnings || [];
    for (const warning of warnings) onProgress(`chapter ${chapter} review ${lens.id}: warning: ${warning}`);
    return { status: result.ok ? "recorded" : "failed", error: result.ok ? null : result.errors.join("; "), packet_id: packet.id,
      ...(warnings.length ? { warnings } : {}), ...(result.answer_file ? { answer_file: result.answer_file } : {}) };
  });
  for (const chapter of chapters) await unit(`chapter ${chapter} repair`, async (retryHost) => {
    const inputs = repairInputs(root, project, chapter), existing = readProposal(root, chapter);
    if (existing && ["ready", "nothing-to-repair"].includes(existing.status) && !proposalIsStale(existing, inputs)) return { status: "skipped", proposal_status: existing.status };
    const result = await repairChapter(root, project, { chapter, run, host: retryHost, onProgress: () => {} });
    return { status: result.status, proposal_status: result.status, chapter, error: result.error || null,
      dropped_edits: result.dropped_edits || [],
      ...(result.status === "no-usable-edits" ? { ask_again: `weaver repair --chapter ${chapter} --run` } : {}) };
  });
  record.status = "complete";
  record.finished_at = new Date().toISOString();
  record.summary = {
    chapters_checked: record.units.find((entry) => entry.unit === "check")?.chapters || 0,
    scenes_recorded: record.units.filter((entry) => entry.unit.startsWith("scene ") && entry.status === "recorded").length,
    reviews_run: record.units.filter((entry) => entry.unit.includes(" review ") && entry.status === "recorded").length,
    proposals_ready: record.units.filter((entry) => entry.proposal_status === "ready").length,
    no_usable_edits: record.units.filter((entry) => entry.proposal_status === "no-usable-edits")
      .map(({ chapter, dropped_edits, ask_again }) => ({ chapter, status: "no-usable-edits", dropped_edits, ask_again })),
    proposals_declined: record.units.filter((entry) => entry.proposal_status === "declined").length,
    nothing_to_repair: record.units.filter((entry) => entry.proposal_status === "nothing-to-repair").length,
    failures: record.units.filter((entry) => entry.status === "failed").map(({ unit, error }) => ({ unit, error })),
    total_seconds: (Date.now() - started) / 1000
  };
  persist();
  return { ...record, path };
}
