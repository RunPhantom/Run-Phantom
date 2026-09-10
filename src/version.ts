declare const __RUNPHANTOM_VERSION__: string | undefined;
declare const __RUNPHANTOM_PACKAGED__: boolean | undefined;

export const VERSION: string =
  typeof __RUNPHANTOM_VERSION__ === "string" && __RUNPHANTOM_VERSION__.length > 0
    ? __RUNPHANTOM_VERSION__
    : "0.0.0-dev";

/** Set only by the compiled release build; source execution always returns false. */
export const IS_PACKAGED_RUNTIME =
  typeof __RUNPHANTOM_PACKAGED__ === "boolean" && __RUNPHANTOM_PACKAGED__;
