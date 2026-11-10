'use strict';

/**
 * FlowStudio Lite — QUEUE-BUILD DEDUPE (v2.48.78, Item B).
 *
 * Field saboot (2026-11-10 11:39–11:43): MCP
 * flowstudio_generate_in_app se bheja gaya EK prompt
 * app ke incomplete-project record me DO missing
 * scenes ban gaya — dono ka tag NSR15-D3-76TEST —
 * aur Redo Missing ne usi ek scene ke liye
 * 2 prompts × 7 credits ka plan bana liya. Tehreeq
 * me pata chala ke queue-build (db.createBatchTasks)
 * har entry ko hu-bahu ek task row bana deta tha —
 * kahin koi dedupe nahi thi — aur missing-scene
 * pipeline (sequenceReport) bhi har row/entry ko
 * alag scene gin leti thi. Doubling jis bhi darwaze
 * se aaye (box-sync + enqueue, ya redo ke recreated
 * items), natija ek hi tha: ek asal scene, do
 * records, do guna credits ka khatra.
 *
 * Ye khalis helper usi darwaze ko band karta hai:
 * EK batch ke andar (tag + prompt text) bilkul ek
 * jaise entries sirf EK task banti hain; baaki
 * dropped me jati hain aur bulane wala har dropped
 * entry ke liye [ROOT] duplicate-queue-entry line
 * log karta hai. Sirf text wali entries par laagu —
 * khaali-text entries is jaanch se bahar hain (un ki
 * apni alag fail-wajah neeche chalti hai, v2.23.0).
 * Tag mukhtalif ho ya text mukhtalif ho to entry
 * asal hai — kabhi drop nahi hoti.
 */

function entryKey(entry) {
  const tag = String((entry && entry.tag) || '').trim();
  const text = String((entry && entry.text) || '').trim();
  if (!text) return null;
  return `${tag}\n${text}`;
}

/**
 * entries: normalized items [{ text, tag, index }]
 * (createBatchTasks ki apni shakal). Lautta hai
 * { kept: [...], droppedTags: [...] } — kept me
 * tartib waisi ki waisi, droppedTags har girayi hui
 * entry ka tag (log line ke liye).
 */
function dedupeBatchEntries(entries) {
  const list = Array.isArray(entries) ? entries : [];
  const seen = new Set();
  const kept = [];
  const droppedTags = [];
  for (const entry of list) {
    const key = entryKey(entry);
    if (key !== null) {
      if (seen.has(key)) {
        droppedTags.push(String((entry && entry.tag) || '').trim());
        continue;
      }
      seen.add(key);
    }
    kept.push(entry);
  }
  return { kept, droppedTags };
}

/** [ROOT] line jo har dropped entry par log hoti hai. */
function duplicateQueueEntryLogLine(tag) {
  return `[ROOT] duplicate-queue-entry dropped tag=${String(tag || '').trim()}`;
}

module.exports = { dedupeBatchEntries, duplicateQueueEntryLogLine };
