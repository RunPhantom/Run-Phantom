import { type ClassValue, clsx } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

// The type-scale utilities (`text-11` … `text-28`, tailwind.config.js) are
// unknown to tailwind-merge, which then reads them as text colours and drops
// them whenever a `text-rp-*` colour follows in the same cn() call.
const twMerge = extendTailwindMerge({
  extend: {
    classGroups: {
      "font-size": [{ text: ["label", "default", "message", "header", "11", "12", "13", "14", "17", "22", "26", "28"] }],
    },
  },
});

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
