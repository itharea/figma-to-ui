// Re-address published-library `assetRef` bindings onto the local guids every
// resolver in lib/ actually reads.
//
// WHY: a .fig exported from a file that SUBSCRIBES to its own published library binds
// variables, text styles and paint styles by `{assetRef:{key,version}}` instead of
// `{guid:{sessionID,localID}}`. Every resolver here reads `.guid` (`alias.guid ?? alias`
// in tokens-lib.followAlias, `paint.colorVar.value.alias.guid`, `styleIdForText?.guid`,
// `variableSetID`), so on such an export they resolve NOTHING — and silently: the IR
// falls back to raw hex, frozen px and unbound typography, and every downstream artifact
// looks plausible while being entirely untokenised. (Observed on a 56-component library
// export: 4,636 paint aliases, 100% of them `assetRef`, 0 `guid`; 17,568 rewrites.)
//
// The referenced assets are present in the SAME file — every node that publishes one
// carries its `key` — so `key → guid` is exact and lossless. This is re-addressing, not
// inference: nothing is guessed, and a key that names no local node is left alone.
//
// Runs unconditionally from `figma-index.load()`, because a caller who forgets it gets
// confidently wrong output with no error. It is a strict no-op on an export that already
// addresses by guid (an existing `guid` always wins, and a file where no node publishes a
// key skips the traversal outright), and idempotent — re-running rewrites nothing.

export type AssetRefReport = {
  // nodes publishing a `key` — the size of the key→guid map
  keyedAssets: number;
  // objects that gained a sibling `guid`
  rewrites: number;
  // field trail (e.g. "SYMBOL/fillPaints[]/colorVar/value/alias") → rewrite count
  byField: Record<string, number>;
  // assetRef key that names no local node → how many references used it
  unresolved: Record<string, number>;
};

type Guid = { sessionID: number; localID: number };

// The trail is carried as raw segments and only joined when there is something to report,
// because the walk visits every object in the message (millions on a real export) while
// rewriting a few thousand — building the path string on every visit is the one thing
// that would make this pass expensive. `[]` marks an array hop and glues to its key.
function fieldPath(trail: string[]): string {
  let out = "";
  for (const seg of trail) out += seg === "[]" || out === "" ? seg : "/" + seg;
  return out;
}

// Build `key → local guid` from every keyed node, then rewrite in place. Mutates `msg`
// and returns what it did, so a CLI can report it and the pipeline can ignore it.
export function normalizeAssetRefs(msg: any): AssetRefReport {
  const nodes: any[] = msg?.nodeChanges ?? [];
  const report: AssetRefReport = { keyedAssets: 0, rewrites: 0, byField: {}, unresolved: {} };

  const byAssetKey = new Map<string, Guid>();
  for (const n of nodes) {
    if (n && typeof n.key === "string" && n.key && n.guid) byAssetKey.set(n.key, n.guid);
  }
  report.keyedAssets = byAssetKey.size;

  // No node publishes a key ⇒ no assetRef in this file could resolve locally ⇒ the walk
  // could only ever report unresolved keys. Skip it: `load()` runs on every CLI, and this
  // keeps the ordinary guid-addressed export free of a full traversal of the message.
  if (byAssetKey.size === 0) return report;

  const trail: string[] = [];

  // One pass, every object visited once. Descends only into object-valued fields, so the
  // primitive leaves (the overwhelming majority of a decoded message) cost nothing.
  const visit = (o: any): void => {
    if (Array.isArray(o)) {
      trail.push("[]");
      for (const v of o) visit(v);
      trail.pop();
      return;
    }
    if (!o || typeof o !== "object") return;

    const ref = o.assetRef;
    if (ref && typeof ref === "object" && typeof ref.key === "string") {
      const guid = byAssetKey.get(ref.key);
      if (!guid) {
        // A genuinely external / detached asset (observed: `detachedSymbolId` naming an
        // asset that is not in the file). Reported, never invented.
        report.unresolved[ref.key] = (report.unresolved[ref.key] ?? 0) + 1;
      } else if (!o.guid) {
        // Non-destructive: `assetRef` stays. An existing `guid` always wins, which is what
        // makes the pass a no-op on a guid-addressed export and idempotent on a re-run.
        o.guid = { sessionID: guid.sessionID, localID: guid.localID };
        report.rewrites++;
        const p = fieldPath(trail);
        report.byField[p] = (report.byField[p] ?? 0) + 1;
      }
      // Fall through rather than returning: an assetRef holder is a leaf in every shape
      // seen so far, but assuming that is exactly how this defect stayed invisible.
    }

    for (const k of Object.keys(o)) {
      const v = o[k];
      if (v !== null && typeof v === "object") {
        trail.push(k);
        visit(v);
        trail.pop();
      }
    }
  };

  for (const n of nodes) {
    trail.length = 0;
    trail.push(typeof n?.type === "string" ? n.type : "");
    visit(n);
  }
  return report;
}
