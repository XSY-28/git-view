/** Presentation-only DAG layout. Lanes are temporary drawing coordinates, never branch identities. */
export interface GraphCommit { oid: string; parents: readonly string[]; boundary?: boolean }
export interface GraphSegment { fromLane: number; toLane: number; from: 'top' | 'node'; to: 'node' | 'bottom' }
export interface GraphRow { oid: string; lane: number; segments: GraphSegment[]; boundary: boolean }
export interface GraphLayout { rows: GraphRow[]; laneCount: number; continuations: { oid: string; lane: number }[] }

/** Input is a topological newest-first window. Unloaded parents remain explicit continuations. */
export function layoutHistory(commits: readonly GraphCommit[]): GraphLayout {
  const lanes: (string | null)[] = [];
  const rows: GraphRow[] = [];
  let laneCount = 1;
  for (const commit of commits) {
    let lane = lanes.indexOf(commit.oid);
    const hasIncoming = lane >= 0;
    if (lane < 0) {
      lane = lanes.indexOf(null);
      if (lane < 0) lane = lanes.length;
      lanes[lane] = commit.oid;
    }
    const segments: GraphSegment[] = [];
    for (let index = 0; index < lanes.length; index++) {
      if (lanes[index] !== null && index !== lane) segments.push({ fromLane: index, toLane: index, from: 'top', to: 'bottom' });
    }
    if (hasIncoming) segments.push({ fromLane: lane, toLane: lane, from: 'top', to: 'node' });
    lanes[lane] = null;
    // A shallow boundary is not a real root. Its missing history is shown at the node.
    if (!commit.boundary) for (const parent of [...new Set(commit.parents)]) {
      let parentLane = lanes.indexOf(parent);
      if (parentLane < 0) {
        parentLane = lanes.indexOf(null);
        if (parentLane < 0) parentLane = lanes.length;
        lanes[parentLane] = parent;
      }
      segments.push({ fromLane: lane, toLane: parentLane, from: 'node', to: 'bottom' });
    }
    laneCount = Math.max(laneCount, lanes.length, lane + 1);
    rows.push({ oid: commit.oid, lane, segments, boundary: Boolean(commit.boundary) });
  }
  return { rows, laneCount, continuations: lanes.flatMap((oid, lane) => oid ? [{ oid, lane }] : []) };
}
