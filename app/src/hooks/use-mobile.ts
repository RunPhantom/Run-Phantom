import * as React from "react";

const MOBILE_BREAKPOINT = 1024;
const COMPACT_WORKSPACE_BREAKPOINT = 1280;

function useViewportBelow(breakpoint: number): boolean {
  const [matches, setMatches] = React.useState(
    () => typeof window !== "undefined" && window.innerWidth < breakpoint,
  );

  React.useEffect(() => {
    const mql = window.matchMedia(`(max-width: ${breakpoint - 1}px)`);
    const onChange = () => setMatches(mql.matches);
    mql.addEventListener("change", onChange);
    onChange();
    return () => mql.removeEventListener("change", onChange);
  }, [breakpoint]);

  return matches;
}

export function useIsMobile(): boolean {
  return useViewportBelow(MOBILE_BREAKPOINT);
}

export function useIsCompactWorkspace(): boolean {
  return useViewportBelow(COMPACT_WORKSPACE_BREAKPOINT);
}
