// Shared node-graph index for decoded .fig messages.
// Every script takes the path to message.json (produced by parse.mts) as argv[2].
import * as fs from "fs";

export const key = (g: any) => `${g.sessionID}:${g.localID}`;

export function load(messagePath: string) {
  if (!messagePath) throw new Error("missing message.json path argument");
  const msg = JSON.parse(fs.readFileSync(messagePath, "utf8"));
  const nodes: any[] = msg.nodeChanges ?? [];
  const byKey = new Map<string, any>();
  for (const n of nodes) byKey.set(key(n.guid), n);
  const children = new Map<string, any[]>();
  for (const n of nodes) {
    if (!n.parentIndex) continue;
    const pk = key(n.parentIndex.guid);
    if (!children.has(pk)) children.set(pk, []);
    children.get(pk)!.push(n);
  }
  for (const arr of children.values())
    arr.sort((a, b) => (a.parentIndex.position < b.parentIndex.position ? -1 : 1));
  return { msg, nodes, byKey, children };
}

export function colorStr(c: any): string {
  if (!c) return "";
  const h = (v: number) =>
    Math.round((v ?? 0) * 255)
      .toString(16)
      .padStart(2, "0");
  return `#${h(c.r)}${h(c.g)}${h(c.b)}${c.a !== undefined && c.a < 1 ? h(c.a) : ""}`;
}

// --- affine transforms (one implementation, reused by export-svg + absCoords) ---
// Mat = [m00 m01 m02 m10 m11 m12]; the 2x3 affine [a b tx; c d ty].
export type Mat = [number, number, number, number, number, number];
export const I: Mat = [1, 0, 0, 0, 1, 0];
export function mul(a: Mat, b: Mat): Mat {
  return [
    a[0] * b[0] + a[1] * b[3],
    a[0] * b[1] + a[1] * b[4],
    a[0] * b[2] + a[1] * b[5] + a[2],
    a[3] * b[0] + a[4] * b[3],
    a[3] * b[1] + a[4] * b[4],
    a[3] * b[2] + a[4] * b[5] + a[5],
  ];
}
export function nodeMat(n: any): Mat {
  const t = n?.transform;
  return t ? [t.m00, t.m01, t.m02, t.m10, t.m11, t.m12] : I;
}

// Absolute on-screen origin of a RAW-tree node: compose every ancestor's full
// affine from the page root down to the node, then read the translation
// (m02,m12) of the product. Composing — not summing m02/m12 — is required so a
// rotated/scaled ancestor (common for icon instances) is handled correctly.
//
// SCOPE: walks the raw `parentIndex` chain, so it is valid ONLY for nodes sitting
// directly in the raw frame tree (what `dump.mts --abs` prints). It is NOT valid
// for a resolved instance child (that child's raw parentIndex points into the
// master/component page, and its guid is non-unique in a resolved tree). The IR
// computes abs coords over the RESOLVED tree (Phase 7) with the same helpers; do
// not call absCoords on composed nodes.
//
// Pitfall (P2-3): on-screen position is not just parent-relative m02/m12 —
// wrapper frames carry real left-padding and earlier siblings' gaps/widths, so
// intermediate frames must not be collapsed; this composes the whole chain.
export function absMat(
  index: { byKey: Map<string, any> } | Map<string, any>,
  guidKey: string,
): Mat {
  const byKey: Map<string, any> = index instanceof Map ? index : index.byKey;
  const start = byKey.get(guidKey);
  if (!start) throw new Error("absMat: node not found: " + guidKey);
  // collect ancestor chain root→node
  const chain: any[] = [];
  let cur: any = start;
  while (cur) {
    chain.unshift(cur);
    cur = cur.parentIndex ? byKey.get(key(cur.parentIndex.guid)) : null;
  }
  let m: Mat = I;
  for (const n of chain) m = mul(m, nodeMat(n));
  return m;
}

export function absCoords(
  index: { byKey: Map<string, any> } | Map<string, any>,
  guidKey: string,
): { absX: number; absY: number } {
  const m = absMat(index, guidKey);
  return { absX: Math.round(m[2]), absY: Math.round(m[5]) };
}
