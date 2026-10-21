/** Return the previous object while a new value is deep-equal to it (JSON), so
 *  memoised chart series keep their identity across identical polls. */

import { useRef } from "react";
import { stabilize } from "../lib/kalshiFlow";

export function useStableData<T>(next: T | null): T | null {
  const ref = useRef<{ json: string; value: T } | null>(null);
  if (next == null) return null;
  ref.current = stabilize(ref.current, next);
  return ref.current.value;
}
