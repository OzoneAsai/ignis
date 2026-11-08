// IME composition has a private, frozen view of the document. Remote Yjs
// updates continue entering the live document, while the browser's composing
// contentDOM is never rewritten. Each provisional editor change is published
// from that frozen history into the live document, so other devices see IME
// text while it is still being composed. Their edits are not overwritten.
import * as Y from "yjs";
import { localChanges } from "./collaboration-editor.js";

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
