// IME composition has a private, frozen view of the document. Remote Yjs
// updates continue entering the live document, while the browser's composing
// contentDOM is never rewritten. Each provisional editor change is published
// from that frozen history into the live document, so other devices see IME
// text while it is still being composed. Their edits are not overwritten.
import * as Y from "yjs";
import { localChanges, deltaToChanges } from "./collaboration-editor.js";

// Projection guard is a span of UNCOMMITTED input in the native editor view.
// It is not a network-disconnect state. Only remote transactions intersecting
// that exact span must be held; edits elsewhere may be rendered immediately.
export function independentCompositionDelta(delta, guard) {
  if (!guard || !Number.isSafeInteger(guard.from) ||
      !Number.isSafeInteger(guard.to)) return false;
  const changes = deltaToChanges(delta);
  return changes.every(({from,to}) =>
    to < guard.from || from > guard.to);
}

// Source Y.Doc keeps *all* remote changes, including those that overlap an
// in-flight composition. The presentation snapshot must have a different
// admission rule. Probe each remote update against the snapshot before
// touching CodeMirror. A prior conflict does not prevent an independent
// participant's later update from rendering.
//
// The callback must apply precisely the probed delta to the editor and
// return true only on success. The snapshot is then advanced with the
// original Yjs operation IDs, so the next IME edit cannot re-author
// somebody else's text.
export function projectIndependentCompositionUpdate(
  snapshot, update, guard, onIndependent
) {
  if (!snapshot?.doc || !guard) {
    return { projected:false, guard, reason:"unavailable" };
  }
  const probe=beginComposition(snapshot.doc);
  let delta=null;
  try {
    probe.text.observe(event=>{delta=event.delta;});
    Y.applyUpdate(probe.doc,update,"ime-projection-probe");
    if (!delta || !delta.length) {
      return { projected:true, guard, reason:"no-text-change" };
    }
    if (!independentCompositionDelta(delta,guard)) {
      return { projected:false, guard, reason:"candidate-overlap" };
    }
    if (!onIndependent(probe.text,delta)) {
      return { projected:false, guard, reason:"presentation-not-ready" };
    }
    Y.applyUpdate(snapshot.doc,update,"ime-accepted-peer");
    return { projected:true, guard:shiftCompositionGuard(guard,delta) };
  } finally {
    probe.doc.destroy();
  }
}

export function shiftCompositionGuard(guard, delta) {
  if (!guard) return null;
  const changes = deltaToChanges(delta);
  let shift = 0;
  for (const change of changes) {
    if (change.to < guard.from) {
      shift += change.insert.length - (change.to-change.from);
    }
  }
  return {from:guard.from+shift,to:guard.to+shift};
}

export function widenCompositionGuard(guard, before, after) {
  if (!guard) return null;
  if (before===after) return guard;
  let from=guard.from,to=guard.to;
  let shift=0;
  for(const change of deltaToChanges(localChanges(before,after))) {
    const actualFrom=change.from+shift;
    const actualTo=actualFrom+change.insert.length;
    const removed=change.to-change.from;
    const movement=change.insert.length-removed;
    if (change.to < from) {
      from+=movement;to+=movement;
    } else {
      from=Math.min(from,actualFrom);
      to=Math.max(to+movement,actualTo);
    }
    shift+=movement;
  }
  return {from:Math.max(0,from),to:Math.max(from,to)};
}

export function beginComposition(doc) {
  const draft = new Y.Doc();
  Y.applyUpdate(draft, Y.encodeStateAsUpdate(doc), "composition-snapshot");
  return { doc: draft, text: draft.getText("content") };
}

export function publishComposition(live, snapshot, edited, origin) {
  const before = snapshot.text.toString();
  if (before === edited) return false;
  snapshot.doc.transact(() => {
    snapshot.text.applyDelta(localChanges(before, edited));
  }, "composition-draft");
  // Only the unseen operations from this private history reach the live Yjs
  // document. Remote inserts received meanwhile remain in the live history.
  const update = Y.encodeStateAsUpdate(snapshot.doc, Y.encodeStateVector(live));
  Y.applyUpdate(live, update, origin);
  return true;
}

export function commitComposition(live, snapshot, edited, origin) {
  try {
    publishComposition(live, snapshot, edited, origin);
  } finally {
    snapshot.doc.destroy();
  }
}
