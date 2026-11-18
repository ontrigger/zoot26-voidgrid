// Clicking the view describes what's under the pointer (or under the cross, in fly mode with the mouse captured).

export interface Hit {
  distance: number;
  text: string;
}

export interface Candidate {
  hit: Hit | null;
  /** how far behind the collision hit this may lie and still be shown: floor samples and cells sit on or in it */
  slack: number;
}

/**
 * What a click picks. `candidates` go in order of precedence: one wins when it's no farther than any after it, and no
 * more than its slack behind the collision hit. Failing all, the collision hit.
 */
export function choose(candidates: Candidate[], collision: Hit | null): string {
  for (const [k, { hit, slack }] of candidates.entries()) {
    if (!hit) continue;
    if (collision && hit.distance > collision.distance + slack) continue;
    if (candidates.slice(k + 1).some(c => c.hit && c.hit.distance < hit.distance)) continue;
    return hit.text;
  }
  return collision ? `${collision.text}\n(no cell in front of it)` : 'nothing there';
}

export const fmt = (digits: number, ...v: number[]) => v.map(x => x.toFixed(digits)).join(' ');
